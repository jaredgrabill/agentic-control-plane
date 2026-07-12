import type { AuditEvent } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_ALGORITHM,
  GENESIS_PREV_HASH,
  computeRecordHash,
  verifyChainPage,
  type ChainRow,
} from '../src/chain.js';

const TENANT = 'acme';

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f50',
    occurred_at: '2026-07-11T09:00:12Z',
    tenant: TENANT,
    event_type: 'tool.called',
    actor: { principal: 'agent:change-agent@0.1.0', delegation_chain: [{ sub: 'user:jane' }] },
    action: { name: 'tool:cloud-estate:cost_report' },
    reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    ...over,
  } as AuditEvent;
}

/** Chains `events` from genesis into ordered ChainRows, exactly as the store does. */
function chain(events: AuditEvent[]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prevHash = GENESIS_PREV_HASH;
  events.forEach((e, i) => {
    const chainSeq = i + 1;
    const recordHash = computeRecordHash({ tenant: TENANT, chainSeq, prevHash, event: e });
    rows.push({ chain_seq: chainSeq, prev_hash: prevHash, record_hash: recordHash, event: e });
    prevHash = recordHash;
  });
  return rows;
}

describe('computeRecordHash canonicalization', () => {
  it('is a sha256:<hex> digest and stable across runs', () => {
    const h = computeRecordHash({ tenant: TENANT, chainSeq: 1, prevHash: GENESIS_PREV_HASH, event: event() });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(
      computeRecordHash({ tenant: TENANT, chainSeq: 1, prevHash: GENESIS_PREV_HASH, event: event() }),
    );
  });

  it('survives a JSON round-trip (jsonb re-parse) unchanged — key order + floats', () => {
    // The design pins: hash over the parsed JS value; verify re-parses stored
    // jsonb and re-stableStringifys. Nasty floats/exponents/unicode/key-order.
    const ev = event({
      details: {
        cost_usd: 0.001,
        ratio: 0.1 + 0.2, // 0.30000000000000004
        tiny: 1e-7,
        big: 123456789.123,
        unicode: 'café — obéir 🚦',
        nested: { z: 1, a: 2, m: [3, 2, 1] },
      },
    } as Partial<AuditEvent>);
    const direct = computeRecordHash({ tenant: TENANT, chainSeq: 5, prevHash: GENESIS_PREV_HASH, event: ev });
    const roundTripped = computeRecordHash({
      tenant: TENANT,
      chainSeq: 5,
      prevHash: GENESIS_PREV_HASH,
      // jsonb round-trip: serialize then re-parse (the pg driver's behavior).
      event: JSON.parse(JSON.stringify(ev)),
    });
    expect(roundTripped).toBe(direct);
  });

  it('changes when tenant, seq, prev_hash, or event changes (binds all four)', () => {
    const base = { tenant: TENANT, chainSeq: 3, prevHash: GENESIS_PREV_HASH, event: event() };
    const h = computeRecordHash(base);
    expect(computeRecordHash({ ...base, tenant: 'other' })).not.toBe(h);
    expect(computeRecordHash({ ...base, chainSeq: 4 })).not.toBe(h);
    expect(computeRecordHash({ ...base, prevHash: `sha256:${'1'.repeat(64)}` })).not.toBe(h);
    expect(computeRecordHash({ ...base, event: event({ event_type: 'model.invoked' }) })).not.toBe(h);
  });

  it('uses the algorithm tag so a format change is detectable', () => {
    expect(CHAIN_ALGORITHM).toBe('acp-audit-chain/v1');
  });
});

describe('verifyChainPage', () => {
  const genesis = { seq: 1, prevHash: GENESIS_PREV_HASH };
  const three = () => chain([event({ event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51' }), event({ event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f52' }), event({ event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f53' })]);

  it('accepts a clean chain from genesis and advances the anchor', () => {
    const res = verifyChainPage(TENANT, three(), genesis);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checked).toBe(3);
      expect(res.anchor.seq).toBe(4);
      expect(res.anchor.prevHash).toBe(three().at(-1)!.record_hash);
    }
  });

  it('reports genesis_mismatch when the first record does not anchor at genesis', () => {
    const rows = three();
    rows[0]!.prev_hash = `sha256:${'9'.repeat(64)}`;
    const res = verifyChainPage(TENANT, rows, genesis);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('genesis_mismatch');
  });

  it('reports link_mismatch when an interior link is broken', () => {
    const rows = three();
    rows[1]!.prev_hash = `sha256:${'9'.repeat(64)}`;
    const res = verifyChainPage(TENANT, rows, genesis);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe('link_mismatch');
      expect(res.failure.chain_seq).toBe(2);
    }
  });

  it('reports seq_gap when a sequence number is skipped', () => {
    const rows = three();
    rows[1]!.chain_seq = 99;
    const res = verifyChainPage(TENANT, rows, genesis);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe('seq_gap');
  });

  it('reports hash_mismatch when a record is mutated but its hash is untouched', () => {
    const rows = three();
    rows[2]!.event = { ...rows[2]!.event, event_type: 'killswitch.activated' };
    const res = verifyChainPage(TENANT, rows, genesis);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe('hash_mismatch');
      expect(res.failure.chain_seq).toBe(3);
    }
  });

  it('verifies a suffix against a supplied (non-genesis) anchor', () => {
    const rows = three();
    const suffix = rows.slice(1); // seq 2, 3
    const res = verifyChainPage(TENANT, suffix, { seq: 2, prevHash: rows[0]!.record_hash });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checked).toBe(2);
  });
});
