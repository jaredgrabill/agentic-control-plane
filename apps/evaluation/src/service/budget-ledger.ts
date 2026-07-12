/**
 * Per-tenant spend ledger, IO adapters (Phase 4 item 1): the Postgres ledger
 * (authoritative running total), the durable task.completed JetStream
 * consumer, and the reservation reaper. The decision logic they defer to is
 * the pure core in budget.ts (unit-tested); these adapters are exercised in
 * E2E against the live stack, like the pg scores store.
 */

import { AUDIT_STREAM, assertTenantId, type Logger } from '@acp/service-kit';
import { AckPolicy, DeliverPolicy, type NatsConnection } from 'nats';
import type pg from 'pg';
import {
  currentPeriodStart,
  handleCompletedEvent,
  type BudgetStatusRow,
  type CommitOutcome,
  type TenantBudgetCaps,
} from './budget.js';

export const BUDGET_LEDGER_CONSUMER = 'acp-budget-ledger';
/** Only terminal task records carry the authoritative cost (usage_totals). */
export const TASK_COMPLETED_FILTER = 'acp.*.audit.task.completed';

export class PgBudgetLedger {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Applies the configured caps for the current period (idempotent upsert).
   * A tenant absent from the caps file has NO cap row → admission is skipped
   * for it entirely (uncapped, no fail-closed exposure).
   */
  async upsertCaps(caps: TenantBudgetCaps, now: Date = new Date()): Promise<void> {
    const period = currentPeriodStart(now);
    for (const [tenant, { cap_usd }] of Object.entries(caps)) {
      assertTenantId(tenant);
      if (!Number.isFinite(cap_usd) || cap_usd < 0) {
        throw new Error(`tenant ${tenant} cap_usd ${cap_usd} is not a non-negative number`);
      }
      await this.pool.query(
        `INSERT INTO tenant_budget (tenant, period_start, cap_micros)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant, period_start) DO UPDATE SET cap_micros = EXCLUDED.cap_micros`,
        [tenant, period, Math.ceil(cap_usd * 1_000_000)],
      );
    }
  }

  /**
   * Books one task's ACTUAL cost, exactly once per task_id, into the
   * RESERVATION's period (month-rollover safe): committed += actual,
   * reserved -= estimate, reservation deleted — all in one transaction.
   * `eventTenant` is the subject-derived tenant; a reservation belonging to a
   * DIFFERENT tenant rolls the whole transaction back (forged-event guard).
   */
  async commitCharge(
    taskId: string,
    eventTenant: string,
    actualMicros: number,
  ): Promise<CommitOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const marker = await client.query(
        `INSERT INTO tenant_budget_charge (task_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [taskId],
      );
      if ((marker.rowCount ?? 0) === 0) {
        // A prior delivery already booked this task.
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      const res = await client.query<{
        tenant: string;
        period_start: string;
        est_micros: string;
      }>(
        `SELECT tenant, period_start, est_micros
           FROM tenant_budget_reservation WHERE task_id = $1 FOR UPDATE`,
        [taskId],
      );
      const reservation = res.rows[0];
      if (reservation === undefined) {
        // Uncapped tenant (no admission ran) — keep the charge marker so a
        // redelivery stays deduped; nothing to move on the ledger.
        await client.query('COMMIT');
        return 'uncapped';
      }
      if (reservation.tenant !== eventTenant) {
        // A forged completion naming another tenant's task: undo the charge
        // marker too, so the REAL event can still book it.
        await client.query('ROLLBACK');
        return 'tenant_mismatch';
      }
      await client.query(
        `UPDATE tenant_budget
            SET committed_micros = committed_micros + $3,
                reserved_micros  = GREATEST(0, reserved_micros - $4)
          WHERE tenant = $1 AND period_start = $2`,
        [reservation.tenant, reservation.period_start, actualMicros, reservation.est_micros],
      );
      await client.query(`DELETE FROM tenant_budget_reservation WHERE task_id = $1`, [taskId]);
      await client.query('COMMIT');
      return 'committed';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Releases reservations older than maxAgeSeconds (a task that never
   * completed must not consume budget permanently). Returns how many were
   * released. The task's cost, if it EVER completes after the reap, dedups on
   * the charge marker and books as 'uncapped' (no reservation to release) —
   * an accepted late-completion approximation.
   */
  async reapExpiredReservations(maxAgeSeconds: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{
        task_id: string;
        tenant: string;
        period_start: string;
        est_micros: string;
      }>(
        `SELECT task_id, tenant, period_start, est_micros
           FROM tenant_budget_reservation
          WHERE created_at < now() - make_interval(secs => $1)
          FOR UPDATE`,
        [maxAgeSeconds],
      );
      for (const row of res.rows) {
        await client.query(
          `UPDATE tenant_budget
              SET reserved_micros = GREATEST(0, reserved_micros - $3)
            WHERE tenant = $1 AND period_start = $2`,
          [row.tenant, row.period_start, row.est_micros],
        );
        await client.query(`DELETE FROM tenant_budget_reservation WHERE task_id = $1`, [
          row.task_id,
        ]);
      }
      await client.query('COMMIT');
      return res.rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The live budget row for a tenant's current period, or undefined (uncapped). */
  async budgetStatus(tenant: string, now: Date = new Date()): Promise<BudgetStatusRow | undefined> {
    const res = await this.pool.query<{
      tenant: string;
      period_start: Date;
      cap_micros: string;
      committed_micros: string;
      reserved_micros: string;
    }>(
      `SELECT tenant, period_start, cap_micros, committed_micros, reserved_micros
         FROM tenant_budget WHERE tenant = $1 AND period_start = $2`,
      [assertTenantId(tenant), currentPeriodStart(now)],
    );
    const row = res.rows[0];
    if (row === undefined) return undefined;
    return {
      tenant: row.tenant,
      period_start: currentPeriodStart(now),
      cap_micros: Number(row.cap_micros),
      committed_micros: Number(row.committed_micros),
      reserved_micros: Number(row.reserved_micros),
    };
  }
}

/**
 * Runs the durable acp-budget-ledger consumer over the audit stream, filtered
 * to task.completed, until stop() is called. Explicit acks: a message is
 * acked once handled (or permanently skippable) and left for redelivery on a
 * transient failure — the charge-marker PK makes redelivery harmless.
 */
export async function startBudgetLedgerConsumer(
  nc: NatsConnection,
  ledger: PgBudgetLedger,
  logger: Logger,
): Promise<{ stop(): void }> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.consumers.add(AUDIT_STREAM, {
      durable_name: BUDGET_LEDGER_CONSUMER,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: TASK_COMPLETED_FILTER,
    });
  } catch (err) {
    // Already exists with the same config → fine; anything else must surface.
    const info = await jsm.consumers.info(AUDIT_STREAM, BUDGET_LEDGER_CONSUMER).catch(() => null);
    if (info === null) throw err;
  }
  const consumer = await nc.jetstream().consumers.get(AUDIT_STREAM, BUDGET_LEDGER_CONSUMER);
  const messages = await consumer.consume();
  // stop() ends the iterator; the loop then drains out on its own.
  void (async () => {
    for await (const msg of messages) {
      const done = await handleCompletedEvent(ledger, msg.subject, msg.data, logger);
      if (done) msg.ack();
      else msg.nak(5_000);
    }
  })();
  logger.info(
    { stream: AUDIT_STREAM, consumer: BUDGET_LEDGER_CONSUMER, filter: TASK_COMPLETED_FILTER },
    'budget ledger consumer running',
  );
  return {
    stop() {
      messages.stop();
    },
  };
}

/**
 * Interval reaper: releases reservations older than maxAgeSeconds. Never
 * throws out of the tick (pg hiccups retry next tick); unref'd so it never
 * keeps the process alive.
 */
export function startBudgetReaper(
  ledger: PgBudgetLedger,
  logger: Logger,
  options: { maxAgeSeconds: number; intervalMs: number },
): { stop(): void } {
  const tick = async (): Promise<void> => {
    try {
      const released = await ledger.reapExpiredReservations(options.maxAgeSeconds);
      if (released > 0) {
        logger.warn({ released }, 'budget reaper released aged task reservations');
      }
    } catch (err) {
      logger.error({ err }, 'budget reaper tick failed — retrying next interval');
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
