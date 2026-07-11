import { auditEvent, ProtocolValidationError } from '@acp/protocol';
import type { Logger } from '@acp/service-kit';
import type { JsMsg } from 'nats';
import type { AuditStore } from './store.js';

export const CONSUMER_NAME = 'audit-writer';

/**
 * Handles one stream message. Exposed separately from the consume loop so
 * the decision logic is unit-testable without a broker:
 *
 * - valid event   → append (idempotent on event_id) → ack
 * - invalid bytes → log + TERM (redelivery cannot fix a malformed event;
 *   parking it beats poisoning the consumer)
 * - store failure → NAK for redelivery (audit-write failure is a platform
 *   incident; the stream retains the event until Postgres accepts it)
 */
export async function handleAuditMessage(
  msg: Pick<JsMsg, 'data' | 'ack' | 'nak' | 'term' | 'subject'>,
  store: AuditStore,
  logger: Logger,
): Promise<void> {
  let event;
  try {
    event = auditEvent.parse(JSON.parse(new TextDecoder().decode(msg.data)));
  } catch (err) {
    logger.error(
      { subject: msg.subject, err },
      err instanceof ProtocolValidationError
        ? 'schema-invalid audit event terminated (producer bug — fix the emitting service)'
        : 'unparseable audit event terminated',
    );
    msg.term();
    return;
  }
  try {
    await store.append(event);
  } catch (err) {
    logger.error({ event_id: event.event_id, err }, 'audit append failed — NAK for redelivery');
    msg.nak();
    return;
  }
  msg.ack();
}
