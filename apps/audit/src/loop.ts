import { AUDIT_STREAM, type Logger } from '@acp/service-kit';
import { AckPolicy, DeliverPolicy, type NatsConnection } from 'nats';
import { CONSUMER_NAME, handleAuditMessage } from './consumer.js';
import type { AuditStore } from './store.js';

/** Durable consumer over the audit stream; runs until the connection closes. */
export async function runConsumer(
  nc: NatsConnection,
  store: AuditStore,
  logger: Logger,
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(AUDIT_STREAM, {
    durable_name: CONSUMER_NAME,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });
  const consumer = await nc.jetstream().consumers.get(AUDIT_STREAM, CONSUMER_NAME);
  const messages = await consumer.consume();
  logger.info({ stream: AUDIT_STREAM, consumer: CONSUMER_NAME }, 'audit consumer running');
  for await (const msg of messages) {
    await handleAuditMessage(msg, store, logger);
  }
}
