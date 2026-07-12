/**
 * Per-tenant budget admission (Phase 4 item 1) — the RESERVE side of the
 * budget. Postgres is AUTHORITATIVE for the running total; admission is ONE
 * atomic conditional UPDATE under the (tenant, period) row lock:
 *
 *   UPDATE tenant_budget SET reserved_micros = reserved_micros + est
 *    WHERE tenant=$1 AND period_start=$2
 *      AND committed_micros + reserved_micros + est <= cap_micros
 *
 * Concurrent submits serialize on the row lock and each re-evaluates the
 * predicate against the POST-predecessor state — no read-then-write window,
 * so no TOCTOU: the invariant committed + reserved ≤ cap holds at every
 * commit point. The evaluation service's ledger consumer later moves each
 * reservation's estimate to the actual committed cost (actual ≤ estimate when
 * the task sets max_cost_usd — the orchestrator's per-task ledger stops
 * dispatch at the cap), and its reaper releases reservations whose task never
 * completed.
 *
 * Fail-closed for CAPPED tenants only: pg unreachable → reserve throws → the
 * gateway 503s. An UNCAPPED tenant has no cap row, reserve answers 'no_cap'
 * (and on pg outage the caller still 503s — the gateway cannot know a tenant
 * is uncapped without asking; the capped/uncapped split is a Postgres answer,
 * not gateway state).
 *
 * The DDL is the same idempotent CREATE IF NOT EXISTS set the evaluation
 * service runs (apps/evaluation/src/service/store.ts) so neither service
 * depends on the other's boot order — keep them in lockstep.
 */

import { env } from '@acp/service-kit';
import pg from 'pg';
import type { BudgetAdmission, BudgetReserveOutcome } from './app.js';

/** The first day of the CURRENT calendar month, UTC — the budget period key. */
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export class PgBudgetAdmission implements BudgetAdmission {
  private readonly pool: pg.Pool;

  constructor(options?: { pool?: pg.Pool; now?: () => Date }) {
    this.pool =
      options?.pool ??
      new pg.Pool({
        connectionString: env(
          'ACP_DATABASE_URL',
          'postgres://acp:acp-dev-password@localhost:5432/acp',
        ),
      });
    this.now = options?.now ?? ((): Date => new Date());
  }

  private readonly now: () => Date;

  /** Idempotent DDL (lockstep with the evaluation service's migrate). */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget (
        tenant           text NOT NULL,
        period_start     date NOT NULL,
        cap_micros       bigint NOT NULL,
        committed_micros bigint NOT NULL DEFAULT 0,
        reserved_micros  bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, period_start)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget_reservation (
        task_id      uuid PRIMARY KEY,
        tenant       text NOT NULL,
        period_start date NOT NULL,
        est_micros   bigint NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget_charge (
        task_id uuid PRIMARY KEY
      )
    `);
  }

  /**
   * Reserves estMicros against the tenant's CURRENT period, atomically. The
   * tenant is the caller's VERIFIED claims.tenant (stamped at the route) —
   * a caller can neither name another tenant's budget nor raise its own cap
   * (caps are platform config, applied by the evaluation service).
   */
  async reserve(tenant: string, taskId: string, estMicros: number): Promise<BudgetReserveOutcome> {
    if (!Number.isSafeInteger(estMicros) || estMicros < 0) {
      throw new Error(`estMicros ${estMicros} must be a non-negative integer`);
    }
    const period = currentPeriodStart(this.now());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE tenant_budget
            SET reserved_micros = reserved_micros + $3
          WHERE tenant = $1 AND period_start = $2
            AND committed_micros + reserved_micros + $3 <= cap_micros`,
        [tenant, period, estMicros],
      );
      if ((updated.rowCount ?? 0) === 0) {
        // Distinguish over-budget from uncapped WITHIN the transaction so a
        // cap row appearing mid-flight cannot be misread as uncapped.
        const cap = await client.query(
          `SELECT 1 FROM tenant_budget WHERE tenant = $1 AND period_start = $2`,
          [tenant, period],
        );
        await client.query('ROLLBACK');
        return (cap.rowCount ?? 0) > 0 ? 'over_budget' : 'no_cap';
      }
      await client.query(
        `INSERT INTO tenant_budget_reservation (task_id, tenant, period_start, est_micros)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (task_id) DO NOTHING`,
        [taskId, tenant, period, estMicros],
      );
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Compensation for a reservation whose task never started (starter.start
   * threw AFTER a successful reserve): give the estimate back. Keyed by BOTH
   * task_id and tenant so even a confused caller cannot release another
   * tenant's reservation.
   */
  async release(tenant: string, taskId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ period_start: string; est_micros: string }>(
        `DELETE FROM tenant_budget_reservation
          WHERE task_id = $1 AND tenant = $2
          RETURNING period_start, est_micros`,
        [taskId, tenant],
      );
      const row = res.rows[0];
      if (row !== undefined) {
        await client.query(
          `UPDATE tenant_budget
              SET reserved_micros = GREATEST(0, reserved_micros - $3)
            WHERE tenant = $1 AND period_start = $2`,
          [tenant, row.period_start, row.est_micros],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
