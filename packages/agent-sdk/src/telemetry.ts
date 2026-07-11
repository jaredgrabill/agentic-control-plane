/**
 * SDK-supplied observability (observability.md): agents built from the
 * template emit correct telemetry with zero effort. The SDK pins the semconv
 * mapping; agents never hand-write attribute names.
 *
 * Deliberately NOT a dependency on @acp/service-kit — that is the
 * control-plane service runtime (fastify/jose/audit/killswitch); agent
 * authors need none of it. The logger/tracing patterns are copied instead.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured JSON logging, trace-correlated: every line carries trace_id /
 * span_id when emitted inside an active span. Level is env-tunable
 * (ACP_LOG_LEVEL); tokens and credentials never reach the log sink.
 */
export function createAgentLogger(agentId: string): Logger {
  return pino({
    name: agentId,
    level: process.env.ACP_LOG_LEVEL ?? 'info',
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: ['*.authorization', '*.token', '*.subject_token', '*.delegated_token', '*.password'],
      censor: '[redacted]',
    },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
  });
}

/**
 * Tracing bootstrap for agent workers. Exports OTLP/HTTP to the collector
 * (ACP_OTLP_ENDPOINT, default: the dev-stack collector). No HTTP
 * auto-instrumentation: agents receive work as Temporal activities, and the
 * Temporal OTel interceptors carry the context.
 */
export function configureTracing(
  serviceName: string,
  options: { spanProcessor?: SpanProcessor } = {},
): Tracer {
  const endpoint = process.env.ACP_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.namespace': 'acp',
    }),
    spanProcessors: [options.spanProcessor ?? new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return trace.getTracer(serviceName);
}
