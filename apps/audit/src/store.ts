import type { AuditEvent } from '@acp/protocol';
import type { Pool } from 'pg';
import { GENESIS_PREV_HASH, computeRecordHash, type ChainRow } from './chain.js';

export interface AuditQuery {
  tenant: string;
  taskId?: string | undefined;
  eventType?: string | undefined;
  /** ISO timestamp; only events with occurred_at >= since are returned (indexed by (tenant, occurred_at)). */
  since?: string | undefined;
  limit?: number | undefined;
}

/** The per-tenant chain head: the highest chain_seq and its record hash. */
export interface ChainHead {
  chain_seq: number;
  record_hash: string;
}

export interface AuditStore {
  /** Idempotent on event_id: JetStream redelivery must not duplicate records nor double-chain. */
  append(event: AuditEvent): Promise<void>;
  query(q: AuditQuery): Promise<AuditEvent[]>;
  /** Ordered chain rows for a tenant with chain_seq >= fromSeq (verification paging). */
  chainPage(tenant: string, fromSeq: number, limit: number): Promise<ChainRow[]>;
  /** The current chain head for a tenant (undefined = empty chain). */
  chainHead(tenant: string): Promise<ChainHead | undefined>;
  /** All ordered chain rows for one task (reconstruction), capped at `limit`. */
  chainByTask(tenant: string, taskId: string, limit: number): Promise<ChainRow[]>;
}

/** Postgres error codes that mean "the head we chained onto was stale": retry once. */
function isChainConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  // 23505 = unique_violation (tenant, chain_seq); P0001 = the chain_check RAISE.
  return code === '23505' || code === 'P0001';
}

export class PgAuditStore implements AuditStore {
  /**
   * Per-tenant in-memory head cache {seq, hash}. Lazily loaded on first append
   * for a tenant, advanced on a successful insert, and invalidated (reloaded) on
   * a chain conflict. The single sequential writer (audit consumer) owns it; an
   * accidental second writer is caught by the DB, not corrupted.
   */
  private readonly heads = new Map<string, ChainHead | undefined>();

  constructor(private readonly pool: Pool) {}

  /**
   * Append-only is enforced in the database, not by convention. Item 5 adds a
   * per-tenant hash chain: chain_seq/prev_hash/record_hash columns, a unique
   * (tenant, chain_seq) index, and a BEFORE-INSERT chain_check trigger that
   * refuses any insert whose linkage does not extend the tenant's head (or, for
   * the first record, the genesis anchor). The trigger checks EQUALITY only — it
   * never recomputes a hash in SQL (jsonb normalization is version-fragile).
   *
   * The migration is idempotent and ordered: drop both triggers, add columns +
   * the unique index, backfill any pre-chain rows in JS (legal only with the
   * append-only trigger dropped), set the columns NOT NULL, then recreate the
   * append-only and chain_check triggers.
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
    `);

    // --- Hash chain migration (idempotent, ordered) ---
    // 1) Drop both triggers so the backfill UPDATE is legal and inserts are not
    //    linkage-checked while columns may still be null.
    await this.pool.query(`
      DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
      DROP TRIGGER IF EXISTS audit_events_chain_check ON audit_events;
      ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS chain_seq   bigint;
      ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS prev_hash   text;
      ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS record_hash text;
      CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_uidx ON audit_events (tenant, chain_seq);
    `);

    // 2) Backfill pre-chain rows (real deployments do this once as an attested
    //    migration; dev data is backfilled inline). Per tenant, ordered by
    //    (recorded_at, event_id) — the append order the chain attests.
    await this.backfillChain();

    // 3) Set NOT NULL only when the backfill left no gaps (guarded).
    const { rows } = await this.pool.query<{ nulls: string }>(
      `SELECT count(*)::text AS nulls FROM audit_events WHERE chain_seq IS NULL`,
    );
    if ((rows[0]?.nulls ?? '0') === '0') {
      await this.pool.query(`
        ALTER TABLE audit_events ALTER COLUMN chain_seq   SET NOT NULL;
        ALTER TABLE audit_events ALTER COLUMN prev_hash   SET NOT NULL;
        ALTER TABLE audit_events ALTER COLUMN record_hash SET NOT NULL;
      `);
    }

    // 4) Recreate the append-only trigger and create the chain_check trigger.
    //    chain_check refuses any insert whose (chain_seq, prev_hash) does not
    //    extend the tenant's head (or the genesis anchor for the first record).
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION audit_events_chain_check() RETURNS trigger AS $$
      DECLARE
        head_seq  bigint;
        head_hash text;
      BEGIN
        SELECT chain_seq, record_hash INTO head_seq, head_hash
          FROM audit_events
          WHERE tenant = NEW.tenant
          ORDER BY chain_seq DESC
          LIMIT 1;
        IF head_seq IS NULL THEN
          IF NEW.chain_seq <> 1 OR NEW.prev_hash <> '${GENESIS_PREV_HASH}' THEN
            RAISE EXCEPTION 'audit chain: first record for tenant % must be genesis (seq 1, prev %), got seq % prev %',
              NEW.tenant, '${GENESIS_PREV_HASH}', NEW.chain_seq, NEW.prev_hash;
          END IF;
        ELSE
          IF NEW.chain_seq <> head_seq + 1 OR NEW.prev_hash <> head_hash THEN
            RAISE EXCEPTION 'audit chain break for tenant %: expected seq % prev %, got seq % prev %',
              NEW.tenant, head_seq + 1, head_hash, NEW.chain_seq, NEW.prev_hash;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
      CREATE TRIGGER audit_events_append_only
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutation();

      DROP TRIGGER IF EXISTS audit_events_chain_check ON audit_events;
      CREATE TRIGGER audit_events_chain_check
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_chain_check();
    `);

    // Reset the cache: heads may have moved during backfill.
    this.heads.clear();
  }

  /** Backfills chain fields for any rows that predate the chain, per tenant, in append order. */
  private async backfillChain(): Promise<void> {
    const { rows: tenants } = await this.pool.query<{ tenant: string }>(
      `SELECT DISTINCT tenant FROM audit_events WHERE chain_seq IS NULL`,
    );
    for (const { tenant } of tenants) {
      // The current head (if the tenant is partly chained already) or genesis.
      const head = await this.chainHead(tenant);
      let seq = head?.chain_seq ?? 0;
      let prevHash = head?.record_hash ?? GENESIS_PREV_HASH;
      const { rows } = await this.pool.query<{ event_id: string; event: AuditEvent }>(
        `SELECT event_id, event FROM audit_events
           WHERE tenant = $1 AND chain_seq IS NULL
           ORDER BY recorded_at ASC, event_id ASC`,
        [tenant],
      );
      for (const row of rows) {
        seq += 1;
        const recordHash = computeRecordHash({ tenant, chainSeq: seq, prevHash, event: row.event });
        await this.pool.query(
          `UPDATE audit_events SET chain_seq = $1, prev_hash = $2, record_hash = $3 WHERE event_id = $4`,
          [seq, prevHash, recordHash, row.event_id],
        );
        prevHash = recordHash;
      }
    }
  }

  async append(event: AuditEvent): Promise<void> {
    const tenant = event.tenant;
    if (!this.heads.has(tenant)) {
      this.heads.set(tenant, await this.chainHead(tenant));
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = this.heads.get(tenant);
      const chainSeq = (head?.chain_seq ?? 0) + 1;
      const prevHash = head?.record_hash ?? GENESIS_PREV_HASH;
      const recordHash = computeRecordHash({ tenant, chainSeq, prevHash, event });
      try {
        const res = await this.pool.query(
          `INSERT INTO audit_events
             (event_id, occurred_at, tenant, event_type, principal, task_id, step_id, event,
              chain_seq, prev_hash, record_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING chain_seq`,
          [
            event.event_id,
            event.occurred_at,
            tenant,
            event.event_type,
            event.actor.principal,
            event.reason?.task_id ?? null,
            event.reason?.step_id ?? null,
            JSON.stringify(event),
            chainSeq,
            prevHash,
            recordHash,
          ],
        );
        if (res.rowCount === 1) {
          // Inserted → advance the head. (A redelivered dup returns 0 rows: the
          // BEFORE trigger passed on fresh-valid fields, then ON CONFLICT
          // suppressed the insert — no double-chain, head unchanged.)
          this.heads.set(tenant, { chain_seq: chainSeq, record_hash: recordHash });
        }
        return;
      } catch (err) {
        if (isChainConflict(err) && attempt === 0) {
          // Our head was stale (a concurrent/second writer, or drift): reload
          // from the DB and retry once. A second failure is a real incident and
          // propagates → the consumer NAKs and the stream redelivers.
          this.heads.set(tenant, await this.chainHead(tenant));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`audit chain append failed after retry for tenant ${tenant}`);
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
    if (q.since !== undefined) {
      params.push(q.since);
      clauses.push(`occurred_at >= $${params.length}`);
    }
    params.push(Math.min(q.limit ?? 200, 1000));
    const res = await this.pool.query<{ event: AuditEvent }>(
      `SELECT event FROM audit_events WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => r.event);
  }

  async chainPage(tenant: string, fromSeq: number, limit: number): Promise<ChainRow[]> {
    const res = await this.pool.query<RawChainRow>(
      `SELECT chain_seq, prev_hash, record_hash, event
         FROM audit_events
         WHERE tenant = $1 AND chain_seq >= $2
         ORDER BY chain_seq ASC
         LIMIT $3`,
      [tenant, fromSeq, limit],
    );
    return res.rows.map(toChainRow);
  }

  async chainHead(tenant: string): Promise<ChainHead | undefined> {
    const res = await this.pool.query<{ chain_seq: string | number; record_hash: string }>(
      `SELECT chain_seq, record_hash FROM audit_events
         WHERE tenant = $1 AND chain_seq IS NOT NULL
         ORDER BY chain_seq DESC LIMIT 1`,
      [tenant],
    );
    const head = res.rows[0];
    // node-pg returns bigint as a string — coerce so the append arithmetic and
    // the verifier see a real number (seq math and JSON canonicalization both
    // depend on it being numeric).
    return head === undefined
      ? undefined
      : { chain_seq: Number(head.chain_seq), record_hash: head.record_hash };
  }

  async chainByTask(tenant: string, taskId: string, limit: number): Promise<ChainRow[]> {
    const res = await this.pool.query<RawChainRow>(
      `SELECT chain_seq, prev_hash, record_hash, event
         FROM audit_events
         WHERE tenant = $1 AND task_id = $2
         ORDER BY chain_seq ASC
         LIMIT $3`,
      [tenant, taskId, limit],
    );
    return res.rows.map(toChainRow);
  }
}

/** A chain row straight from pg — chain_seq arrives as a bigint string. */
interface RawChainRow {
  chain_seq: string | number;
  prev_hash: string;
  record_hash: string;
  event: AuditEvent;
}

/** Coerces the bigint chain_seq to a real number (node-pg returns bigint as a string). */
function toChainRow(r: RawChainRow): ChainRow {
  return {
    chain_seq: Number(r.chain_seq),
    prev_hash: r.prev_hash,
    record_hash: r.record_hash,
    event: r.event,
  };
}
