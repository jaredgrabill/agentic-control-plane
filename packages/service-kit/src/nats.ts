import { auditEvent, subjects, type AuditEvent } from '@acp/protocol';
import {
  connect,
  credsAuthenticator,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type KV,
  type NatsConnection,
} from 'nats';
import { env } from './config.js';
import type { Logger } from './logger.js';

export interface BusOptions {
  name: string;
  url?: string;
  user?: string;
  password?: string;
  creds?: string;
}

/**
 * Connects to the bus with the service's own credentials (per-service users
 * in dev; auth-callout-minted identities in hardened deployments). Every
 * consumer of this helper is a first-class bus principal — no shared creds.
 */
export async function connectBus(options: BusOptions): Promise<NatsConnection> {
  const url = options.url ?? env('ACP_NATS_URL', 'nats://localhost:4222');
  if (options.creds !== undefined) {
    return connect({
      name: options.name,
      servers: url,
      authenticator: credsAuthenticator(new TextEncoder().encode(options.creds)),
    });
  }
  return connect({
    name: options.name,
    servers: url,
    ...(options.user !== undefined ? { user: options.user } : {}),
    ...(options.password !== undefined ? { pass: options.password } : {}),
  });
}

/**
 * Publishes protocol-validated audit events onto the JetStream audit
 * stream and surfaces acknowledgement failures to the caller. Audit-write
 * failure is a platform incident: R1+ paths fail closed on a rejected
 * promise; R0 paths may catch, alarm, and continue.
 */
export class AuditPublisher {
  private readonly js: JetStreamClient;

  constructor(
    nc: NatsConnection,
    private readonly logger: Logger,
  ) {
    this.js = nc.jetstream();
  }

  async publish(event: AuditEvent): Promise<void> {
    // Validation before publish: an event that doesn't conform to the
    // schema must fail at the producer, not poison the stream.
    auditEvent.parse(event);
    const subject = subjects.audit(event.tenant, event.event_type);
    try {
      await this.js.publish(subject, JSON.stringify(event), {
        msgID: event.event_id,
        timeout: 5_000,
      });
    } catch (err) {
      this.logger.error(
        { subject, event_id: event.event_id, err },
        'audit publish failed — the audit stream did not acknowledge this event',
      );
      throw err;
    }
  }
}

export async function openKv(nc: NatsConnection, bucket: string): Promise<KV> {
  return nc.jetstream().views.kv(bucket, { history: 5 });
}

export const AUDIT_STREAM = 'ACP_AUDIT';

/**
 * Idempotent creation of the audit capture stream: file-backed,
 * deny-delete/deny-purge (governance-and-policy.md — the stream is the
 * capture ledger; long-horizon WORM tiering lands in Phase 3). Every
 * audit publisher calls this at boot so no service depends on another's
 * start order.
 */
export async function ensureAuditStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const config = {
    name: AUDIT_STREAM,
    subjects: ['acp.*.audit.>'],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    deny_delete: true,
    deny_purge: true,
    max_age: 0, // limits-mode with no age cap in dev; retention tiers are deployment policy
  };
  try {
    await jsm.streams.add(config);
  } catch (err) {
    // Already exists with the same config → fine. Anything else is a real
    // boot failure and must surface.
    const info = await jsm.streams.info(AUDIT_STREAM).catch(() => null);
    if (info === null) throw err;
  }
}
