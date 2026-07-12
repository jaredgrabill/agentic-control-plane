import type { AuditEvent } from '@acp/protocol';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { GENESIS_PREV_HASH, verifyChainPage, type ChainRow } from '../src/chain.js';
import { PgAuditStore } from '../src/store.js';

/**
 * A minimal in-memory fake of the pieces of `pg.Pool` the chain append path
 * uses: the chainHead SELECT and the INSERT ... ON CONFLICT DO NOTHING. It models
 * the UNIQUE(tenant, chain_seq) + append-only semantics so the head-cache advance,
 * idempotent redelivery, and stale-head retry can be exercised without Postgres
 * (the trigger enforcement itself is E2E'd against the real DB).
 */
class FakePool {
  rows: {
    tenant: string;
    chain_seq: number;
    prev_hash: string;
    record_hash: string;
    event_id: string;
  }[] = [];
  injectConflictOnce = false;
  /** When set, chainHead reports an empty chain even though rows exist — models a persistent conflict. */
  headBlind = false;
  insertCount = 0;

  query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
    if (sql.includes('ORDER BY chain_seq DESC')) {
      if (this.headBlind) return Promise.resolve({ rowCount: 0, rows: [] });
      const tenant = params[0] as string;
      const head = this.rows
        .filter((r) => r.tenant === tenant)
        .sort((a, b) => b.chain_seq - a.chain_seq)[0];
      return Promise.resolve({
        rowCount: head === undefined ? 0 : 1,
        rows:
          head === undefined ? [] : [{ chain_seq: head.chain_seq, record_hash: head.record_hash }],
      });
    }
    if (sql.includes('INSERT INTO audit_events')) {
      this.insertCount += 1;
      if (this.injectConflictOnce && this.insertCount === 1) {
        this.injectConflictOnce = false;
        return Promise.reject(Object.assign(new Error('unique_violation'), { code: '23505' }));
      }
      const eventId = params[0] as string;
      const tenant = params[2] as string;
      const chain_seq = params[8] as number;
      const prev_hash = params[9] as string;
      const record_hash = params[10] as string;
      // ON CONFLICT (event_id) DO NOTHING → 0 rows on a duplicate.
      if (this.rows.some((r) => r.event_id === eventId)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // UNIQUE(tenant, chain_seq) → a stale-head insert would 23505 here.
      if (this.rows.some((r) => r.tenant === tenant && r.chain_seq === chain_seq)) {
        return Promise.reject(Object.assign(new Error('unique_violation'), { code: '23505' }));
      }
      this.rows.push({ tenant, chain_seq, prev_hash, record_hash, event_id: eventId });
      return Promise.resolve({ rowCount: 1, rows: [{ chain_seq }] });
    }
    return Promise.resolve({ rowCount: 0, rows: [] });
  }
}

function ev(id: string, tenant = 'acme', taskId?: string): AuditEvent {
  return {
    event_id: id,
    occurred_at: '2026-07-11T09:00:12Z',
    tenant,
    event_type: 'tool.called',
    actor: { principal: 'svc:orchestrator' },
    action: { name: 'x' },
    ...(taskId === undefined ? {} : { reason: { task_id: taskId } }),
  };
}

const ids = [
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f01',
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f02',
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f03',
];

/** The fake's rows as ChainRows for verifyChainPage (event is not stored by the fake, so re-attach). */
function chainOf(fake: FakePool, events: Record<string, AuditEvent>): ChainRow[] {
  return fake.rows
    .slice()
    .sort((a, b) => a.chain_seq - b.chain_seq)
    .map((r) => ({
      chain_seq: r.chain_seq,
      prev_hash: r.prev_hash,
      record_hash: r.record_hash,
      event: events[r.event_id]!,
    }));
}

describe('PgAuditStore chain append (fake pool)', () => {
  it('assigns per-tenant seq 1..n with genesis-anchored linkage', async () => {
    const fake = new FakePool();
    const store = new PgAuditStore(fake as unknown as Pool);
    const events: Record<string, AuditEvent> = {};
    for (const id of ids) {
      events[id] = ev(id);
      await store.append(events[id]);
    }
    expect(fake.rows.map((r) => r.chain_seq)).toEqual([1, 2, 3]);
    expect(fake.rows[0]!.prev_hash).toBe(GENESIS_PREV_HASH);
    // The produced chain verifies clean.
    const res = verifyChainPage('acme', chainOf(fake, events), {
      seq: 1,
      prevHash: GENESIS_PREV_HASH,
    });
    expect(res.ok).toBe(true);
  });

  it('interleaves tenants into independent chains', async () => {
    const fake = new FakePool();
    const store = new PgAuditStore(fake as unknown as Pool);
    await store.append(ev(ids[0]!, 'acme'));
    await store.append(ev(ids[1]!, 'beta'));
    await store.append(ev(ids[2]!, 'acme'));
    const acme = fake.rows.filter((r) => r.tenant === 'acme').map((r) => r.chain_seq);
    const beta = fake.rows.filter((r) => r.tenant === 'beta').map((r) => r.chain_seq);
    expect(acme).toEqual([1, 2]);
    expect(beta).toEqual([1]);
  });

  it('is idempotent on redelivery — immediately AND after intervening appends (no double-chain)', async () => {
    const fake = new FakePool();
    const store = new PgAuditStore(fake as unknown as Pool);
    await store.append(ev(ids[0]!));
    await store.append(ev(ids[0]!)); // immediate redelivery
    expect(fake.rows).toHaveLength(1);

    await store.append(ev(ids[1]!));
    await store.append(ev(ids[2]!));
    await store.append(ev(ids[0]!)); // redelivery after intervening appends
    expect(fake.rows).toHaveLength(3);
    expect(fake.rows.map((r) => r.chain_seq)).toEqual([1, 2, 3]); // head not advanced by the dup
  });

  it('reloads the head and retries once on an injected chain conflict (23505)', async () => {
    const fake = new FakePool();
    const store = new PgAuditStore(fake as unknown as Pool);
    fake.injectConflictOnce = true;
    await store.append(ev(ids[0]!));
    // The first insert threw 23505; the store reloaded the (empty) head and
    // retried successfully → exactly one row, seq 1.
    expect(fake.insertCount).toBe(2);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.chain_seq).toBe(1);
  });

  it('throws if a chain conflict persists past the single retry', async () => {
    const fake = new FakePool();
    const store = new PgAuditStore(fake as unknown as Pool);
    // Pre-seed seq 1, and make chainHead blind to it: the store computes seq 1,
    // collides (23505), reloads (still blind → seq 1), retries, collides again →
    // the persistent conflict propagates so the consumer NAKs and redelivers.
    fake.rows.push({
      tenant: 'acme',
      chain_seq: 1,
      prev_hash: GENESIS_PREV_HASH,
      record_hash: `sha256:${'a'.repeat(64)}`,
      event_id: 'pre-existing',
    });
    fake.headBlind = true;
    await expect(store.append(ev(ids[0]!))).rejects.toThrow();
  });
});
