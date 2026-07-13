import { auditEvent, type AuditEvent } from '@acp/protocol';
import { AUDIT_STREAM, assertTenantId, type Logger } from '@acp/service-kit';
import { AckPolicy, DeliverPolicy, type JsMsg, type NatsConnection } from 'nats';
import { genKey } from './session-cache.js';

export const INVALIDATOR_CONSUMER = 'session-cache-invalidator';

/** The narrow KV surface the invalidator writes generations through. */
export interface InvalidatorKv {
  get(key: string): Promise<{ string(): string } | null>;
  put(key: string, value: string): Promise<number>;
}

export type InvalidationOutcome = 'bumped' | 'skipped' | 'retry';

/**
 * Handles one audit-stream message for cache invalidation. Exposed separately
 * from the consume loop so the decision logic is unit-testable without a broker.
 *
 * A `corpus.mutation` carries the mutated `source_id` in `details`. We bump
 * `gen.<tenant>.<source_id>` to the message's STREAM sequence — strictly
 * monotonic and gap-free, so the guard is advance-only: a redelivered or
 * out-of-order lower sequence never regresses a generation. Bumping a source's
 * generation invalidates every cached entry that captured an older generation
 * for that source, across all permission snapshots in the tenant — over-
 * eviction is only a miss, so no reverse index from source to entries is needed.
 *
 * We key eviction on source_id (stable across re-ingestion), NOT lineage_id: a
 * changed chunk gets a fresh UUIDv7 lineage_id, so an entry holding the OLD one
 * and a mutation advertising the NEW one would never match.
 */
export async function handleCorpusMutation(
  msg: Pick<JsMsg, 'data' | 'ack' | 'term' | 'nak' | 'seq' | 'subject'>,
  kv: InvalidatorKv,
  logger: Logger,
): Promise<InvalidationOutcome> {
  let event: AuditEvent;
  try {
    event = auditEvent.parse(JSON.parse(new TextDecoder().decode(msg.data)));
  } catch (err) {
    // Redelivery cannot fix a malformed event; park it rather than loop.
    logger.error({ subject: msg.subject, err }, 'unparseable corpus event terminated');
    msg.term();
    return 'skipped';
  }

  // The corpus.> filter also matches any future corpus.* event; only a
  // mutation (or a revocation, should one be added) with a source_id bumps a
  // generation. Anything else is acked and ignored.
  if (event.event_type !== 'corpus.mutation') {
    msg.ack();
    return 'skipped';
  }
  const details = event.details as { source_id?: unknown } | undefined;
  const sourceId = typeof details?.source_id === 'string' ? details.source_id : undefined;
  if (sourceId === undefined) {
    msg.ack();
    return 'skipped';
  }

  let key: string;
  try {
    // Defense in depth: the audit schema's tenant pattern already forbids a
    // KV-illegal tenant, so parse() would have rejected it above — this guard
    // is the belt to that schema's suspenders and cannot regress silently.
    key = genKey(assertTenantId(event.tenant), sourceId);
    /* v8 ignore start -- unreachable given the schema tenant pattern; defensive only */
  } catch (err) {
    logger.error({ tenant: event.tenant, err }, 'corpus.mutation with an invalid tenant ignored');
    msg.ack();
    return 'skipped';
  }
  /* v8 ignore stop */

  const gen = msg.seq;
  try {
    const existing = await kv.get(key);
    const current = existing === null ? 0 : Number(existing.string());
    if (gen > current) {
      await kv.put(key, String(gen));
      msg.ack();
      return 'bumped';
    }
    msg.ack();
    return 'skipped';
  } catch (err) {
    // A transient KV failure would leave a stale entry servable until TTL; NAK
    // so the advance-only bump retries (idempotent — re-applying is a no-op).
    logger.error({ key, err }, 'generation bump failed — NAK for redelivery');
    msg.nak();
    return 'retry';
  }
}

/**
 * Durable consumer over the audit stream's corpus events; runs until the
 * connection closes. Mirrors the audit writer loop (apps/audit/src/loop.ts).
 */
/* v8 ignore start -- broker loop is exercised by the E2E suite, not unit tests */
export async function runSessionCacheInvalidator(
  nc: NatsConnection,
  kv: InvalidatorKv,
  logger: Logger,
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(AUDIT_STREAM, {
    durable_name: INVALIDATOR_CONSUMER,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: 'acp.*.audit.corpus.>',
  });
  const consumer = await nc.jetstream().consumers.get(AUDIT_STREAM, INVALIDATOR_CONSUMER);
  const messages = await consumer.consume();
  logger.info(
    { stream: AUDIT_STREAM, consumer: INVALIDATOR_CONSUMER },
    'session cache invalidator running',
  );
  for await (const msg of messages) {
    await handleCorpusMutation(msg, kv, logger);
  }
}
/* v8 ignore stop */
