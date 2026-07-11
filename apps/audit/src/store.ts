import type { AuditEvent } from '@acp/protocol';
import type { Pool } from 'pg';

export interface AuditQuery {
  tenant: string;
  taskId?: string | undefined;
  eventType?: string | undefined;
  limit?: number | undefined;
}

export interface AuditStore {
  /** Idempotent on event_id: JetStream redelivery must not duplicate records. */
  append(event: AuditEvent): Promise<void>;
  query(q: AuditQuery): Promise<AuditEvent[]>;
}

export class PgAuditStore implements AuditStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Append-only is enforced in the database, not by convention: a trigger
   * rejects UPDATE and DELETE outright. Retention/erasure run as schema
   * operations (partition drops, crypto-shredding) by deployment policy,
   * never as row mutations from application code.
   */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id    uuid PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        tenant      text NOT NULL,
        event_type  text NOT NULL,
        principal   text NOT NULL,
        task_id     uuid,
        step_id     uuid,
        event       jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_task_idx ON audit_events (task_id, occurred_at);
      CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events (tenant, occurred_at);

      CREATE OR REPLACE FUNCTION audit_events_no_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only: % refused', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
      CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutation();
    `);
  }

  async append(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
         (event_id, occurred_at, tenant, event_type, principal, task_id, step_id, event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        event.occurred_at,
        event.tenant,
        event.event_type,
        event.actor.principal,
        event.reason?.task_id ?? null,
        event.reason?.step_id ?? null,
        JSON.stringify(event),
      ],
    );
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    const clauses = ['tenant = $1'];
    const params: unknown[] = [q.tenant];
    if (q.taskId !== undefined) {
      params.push(q.taskId);
      clauses.push(`task_id = $${params.length}`);
    }
    if (q.eventType !== undefined) {
      params.push(q.eventType);
      clauses.push(`event_type = $${params.length}`);
    }
    params.push(Math.min(q.limit ?? 200, 1000));
    const res = await this.pool.query<{ event: AuditEvent }>(
      `SELECT event FROM audit_events WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => r.event);
  }
}
