import { createLogger } from '@acp/service-kit';
import { describe, expect, it } from 'vitest';
import {
  currentPeriodStart,
  handleCompletedEvent,
  type BudgetLedgerLike,
  type CommitOutcome,
} from '../src/service/budget.js';

const logger = createLogger('budget-test');
const TASK = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';

/** Records commitCharge calls; scriptable outcome/failure. */
function fakeLedger(outcome: CommitOutcome = 'committed', fail = false) {
  const calls: { taskId: string; tenant: string; actualMicros: number }[] = [];
  const ledger: BudgetLedgerLike = {
    commitCharge(taskId, tenant, actualMicros) {
      if (fail) return Promise.reject(new Error('pg down'));
      calls.push({ taskId, tenant, actualMicros });
      return Promise.resolve(outcome);
    },
  };
  return { ledger, calls };
}

function completed(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: 'e1',
    tenant: 'globex',
    event_type: 'task.completed',
    reason: { task_id: TASK },
    details: { usage_totals: { input_tokens: 10, output_tokens: 5, cost_usd: 0.012345 } },
    ...over,
  });
}

describe('currentPeriodStart', () => {
  it('is the first day of the current UTC month', () => {
    expect(currentPeriodStart(new Date('2026-07-12T23:59:59Z'))).toBe('2026-07-01');
    expect(currentPeriodStart(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
  });
});

describe('handleCompletedEvent', () => {
  const SUBJECT = 'acp.globex.audit.task.completed';

  it('books the actual cost keyed by the SUBJECT tenant and task_id', async () => {
    const { ledger, calls } = fakeLedger();
    const done = await handleCompletedEvent(ledger, SUBJECT, completed(), logger);
    expect(done).toBe(true);
    expect(calls).toEqual([{ taskId: TASK, tenant: 'globex', actualMicros: 12345 }]);
  });

  it('books 0 micros when pricing was disabled (cost_usd null)', async () => {
    const { ledger, calls } = fakeLedger();
    await handleCompletedEvent(
      ledger,
      SUBJECT,
      completed({ details: { usage_totals: { cost_usd: null } } }),
      logger,
    );
    expect(calls[0]!.actualMicros).toBe(0);
  });

  it('skips (acks) a forged event whose payload tenant differs from its subject', async () => {
    // The subject is what the NATS account boundary constrains; a divergent
    // payload tenant is only possible for a hand-crafted event.
    const { ledger, calls } = fakeLedger();
    const done = await handleCompletedEvent(ledger, SUBJECT, completed({ tenant: 'acme' }), logger);
    expect(done).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('skips (acks) an event without a uuid task_id or with an unparseable body', async () => {
    const { ledger, calls } = fakeLedger();
    expect(
      await handleCompletedEvent(
        ledger,
        SUBJECT,
        completed({ reason: { task_id: 'nope' } }),
        logger,
      ),
    ).toBe(true);
    expect(await handleCompletedEvent(ledger, SUBJECT, 'not-json', logger)).toBe(true);
    expect(
      await handleCompletedEvent(ledger, 'acp..audit.task.completed', completed(), logger),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('acks a cross-tenant reservation refusal (the ledger rolled it back)', async () => {
    const { ledger, calls } = fakeLedger('tenant_mismatch');
    const done = await handleCompletedEvent(ledger, SUBJECT, completed(), logger);
    expect(done).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('returns false (redeliver) on a transient ledger failure', async () => {
    const { ledger } = fakeLedger('committed', true);
    const done = await handleCompletedEvent(ledger, SUBJECT, completed(), logger);
    expect(done).toBe(false);
  });
});
