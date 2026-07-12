import { subjects } from '@acp/protocol';
import { AuthError, type Logger } from '@acp/service-kit';
import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import type { NatsConnection } from 'nats';
import type { SearchRequest, SearchService } from './search.js';

/**
 * The low-latency door the SDK Retriever rides: request-reply on
 * acp.platform.svc.knowledge.search, queue-grouped for horizontal scale.
 * Same SearchService, same verification/policy/audit — transport is an
 * implementation detail, the permission check is not.
 */
export function serveSearchOverBus(
  nc: NatsConnection,
  search: SearchService,
  logger: Logger,
): void {
  const subject = subjects.svc('knowledge', 'search');
  const sub = nc.subscribe(subject, { queue: 'knowledge' });
  logger.info({ subject }, 'knowledge search serving on the bus');
  void (async () => {
    for await (const msg of sub) {
      let payload: SearchRequest;
      try {
        payload = JSON.parse(new TextDecoder().decode(msg.data)) as SearchRequest;
      } catch {
        msg.respond(JSON.stringify({ error: { message: 'request is not JSON', status: 400 } }));
        continue;
      }
      // The caller's W3C context rides the payload; the retrieval span
      // joins the task trace instead of starting an orphan.
      const parent = propagation.extract(context.active(), {
        traceparent: (payload as { traceparent?: string }).traceparent,
      });
      const span = trace
        .getTracer('knowledge')
        .startSpan('knowledge.search', { attributes: { 'acp.transport': 'nats' } }, parent);
      try {
        const results = await context.with(trace.setSpan(parent, span), () =>
          search.search(payload),
        );
        msg.respond(JSON.stringify({ results }));
      } catch (err) {
        const status = err instanceof AuthError ? err.statusCode : 500;
        const message = err instanceof AuthError ? err.message : 'internal error during retrieval';
        if (status >= 500) logger.error({ err }, 'bus search failed');
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        msg.respond(JSON.stringify({ error: { message, status } }));
      } finally {
        span.end();
      }
    }
  })();
}
