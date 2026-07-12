/**
 * B2 regression: the budget reaper must re-apply the current period's caps on
 * every tick, so a UTC month rollover (which leaves no tenant_budget row for
 * the new period) cannot silently uncap every capped tenant until the service
 * is restarted. The reaper is the only always-running upsert after boot.
 */

import { createLogger } from '@acp/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBudgetReaper, type PgBudgetLedger } from '../src/service/budget-ledger.js';
import type { TenantBudgetCaps } from '../src/service/budget.js';

const logger = createLogger('budget-reaper-test');
const INTERVAL_MS = 300_000;

/** Minimal PgBudgetLedger stand-in — the reaper only calls these two. */
function fakeLedger(reapFails = false) {
  const upsertCalls: TenantBudgetCaps[] = [];
  let reapCalls = 0;
  const ledger = {
    upsertCaps(caps: TenantBudgetCaps): Promise<void> {
      upsertCalls.push(caps);
      return Promise.resolve();
    },
    reapExpiredReservations(): Promise<number> {
      reapCalls += 1;
      return reapFails ? Promise.reject(new Error('pg down')) : Promise.resolve(0);
    },
  } as unknown as PgBudgetLedger;
  return {
    ledger,
    upsertCalls,
    get reapCalls() {
      return reapCalls;
    },
  };
}

describe('startBudgetReaper cap re-upsert (B2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-upserts the configured caps on every tick', async () => {
    const caps: TenantBudgetCaps = { globex: { cap_usd: 0.5 } };
    const { ledger, upsertCalls } = fakeLedger();
    const reaper = startBudgetReaper(ledger, logger, {
      maxAgeSeconds: 86_400,
      intervalMs: INTERVAL_MS,
      caps,
    });
    try {
      expect(upsertCalls).toHaveLength(0); // nothing until the first tick fires
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(upsertCalls).toEqual([caps]); // period rows re-materialized
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(upsertCalls).toEqual([caps, caps]); // and again next interval
    } finally {
      reaper.stop();
    }
  });

  it('still reaps even when a tick fails, and skips upsert when no caps configured', async () => {
    const fake = fakeLedger(true);
    const reaper = startBudgetReaper(fake.ledger, logger, {
      maxAgeSeconds: 86_400,
      intervalMs: INTERVAL_MS,
      caps: undefined,
    });
    try {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      // No caps → no upsert, but the reap still ran (and its failure was swallowed).
      expect(fake.upsertCalls).toHaveLength(0);
      expect(fake.reapCalls).toBe(1);
    } finally {
      reaper.stop();
    }
  });
});
