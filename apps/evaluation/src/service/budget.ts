/**
 * Per-tenant spend ledger, PURE core (Phase 4 item 1) — the decision logic of
 * the COMMIT side of the budget, unit-tested here; the pg/NATS IO adapters
 * live in budget-ledger.ts (E2E-covered like the pg scores store).
 *
 * The gateway RESERVES at task intake (apps/gateway/src/budget.ts, one atomic
 * conditional UPDATE under the (tenant, period) row lock); the ledger
 * consumer applies each task.completed exactly once per task_id, moving the
 * reservation's estimate to the actual committed cost.
 *
 * Trust notes (opus QA):
 *   - The tenant an event charges is taken from the SUBJECT
 *     (acp.{tenant}.audit.task.completed) — the NATS account boundary
 *     guarantees a tenant can only publish under its own prefix — and is
 *     cross-checked against the reservation's tenant inside commitCharge: a
 *     forged event naming another tenant's task_id is rolled back and
 *     skipped, so tenant A can never release or charge tenant B's ledger.
 *   - commitCharge is idempotent by task_id (tenant_budget_charge PK +
 *     ON CONFLICT DO NOTHING): a JetStream redelivery re-applies nothing.
 *   - RESIDUAL: an agent CAN publish a fabricated task.completed for its OWN
 *     tenant (the audit template allows acp.{tenant}.audit.>), naming its own
 *     running task with cost 0 to free its reservation early — self-tenant
 *     budget evasion, bounded by that tenant's own cap, on the threat-model
 *     backlog with audit-producer attestation.
 */

import type { Logger } from '@acp/service-kit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The first day of the CURRENT calendar month, UTC — the budget period key. */
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export type TenantBudgetCaps = Record<string, { cap_usd: number }>;

export interface BudgetStatusRow {
  tenant: string;
  period_start: string;
  cap_micros: number;
  committed_micros: number;
  reserved_micros: number;
}

export type CommitOutcome = 'committed' | 'duplicate' | 'uncapped' | 'tenant_mismatch';

/** The shape handleCompletedEvent needs — PgBudgetLedger satisfies it; tests fake it. */
export interface BudgetLedgerLike {
  commitCharge(taskId: string, eventTenant: string, actualMicros: number): Promise<CommitOutcome>;
}

/**
 * Applies one task.completed audit message to the ledger. Returns true when
 * the message is DONE (ack it — applied, duplicate, malformed, or forged) and
 * false only for transient infrastructure failures (nak/redeliver).
 * `subject` is the NATS subject the message arrived on: its tenant token is
 * the authoritative tenant (the account boundary constrains who can publish
 * under a prefix), never the event payload.
 */
export async function handleCompletedEvent(
  ledger: BudgetLedgerLike,
  subject: string,
  data: Uint8Array | string,
  logger: Logger,
): Promise<boolean> {
  const tenant = subject.split('.')[1];
  if (tenant === undefined || !/^[a-z0-9-]+$/.test(tenant)) {
    logger.error({ subject }, 'budget ledger: subject has no tenant token — skipping');
    return true;
  }
  let event: {
    tenant?: string;
    reason?: { task_id?: string };
    details?: { usage_totals?: { cost_usd?: number | null } };
  };
  try {
    event = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as never;
  } catch {
    logger.error({ subject }, 'budget ledger: unparseable task.completed — skipping');
    return true;
  }
  if (event.tenant !== tenant) {
    // Payload/subject divergence is only possible for a hand-crafted event.
    logger.warn(
      { subject, payload_tenant: event.tenant },
      'budget ledger: event tenant does not match its subject — skipping',
    );
    return true;
  }
  const taskId = event.reason?.task_id;
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) {
    logger.warn({ subject }, 'budget ledger: task.completed without a uuid task_id — skipping');
    return true;
  }
  const cost = event.details?.usage_totals?.cost_usd;
  const actualMicros =
    typeof cost === 'number' && Number.isFinite(cost) ? Math.round(cost * 1_000_000) : 0;
  try {
    const outcome = await ledger.commitCharge(taskId, tenant, actualMicros);
    if (outcome === 'tenant_mismatch') {
      logger.warn(
        { subject, task_id: taskId },
        'budget ledger: completion names a task reserved by ANOTHER tenant — refused',
      );
    }
    return true;
  } catch (err) {
    logger.error({ err, task_id: taskId }, 'budget ledger: pg commit failed — will redeliver');
    return false;
  }
}
