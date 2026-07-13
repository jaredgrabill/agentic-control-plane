import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { createLogger } from '@acp/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { handleCorpusMutation, type InvalidatorKv } from '../src/session-cache-invalidator.js';

const logger = createLogger('session-cache-invalidator-test');

class FakeKv implements InvalidatorKv {
  readonly store = new Map<string, string>();
  get(key: string): Promise<{ string(): string } | null> {
    const v = this.store.get(key);
    return Promise.resolve(v === undefined ? null : { string: () => v });
  }
  put(key: string, value: string): Promise<number> {
    this.store.set(key, value);
    return Promise.resolve(1);
  }
}

function mutation(sourceId: string | undefined, tenant = 'acme'): AuditEvent {
  return {
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    tenant,
    event_type: 'corpus.mutation',
    actor: { principal: 'svc:knowledge-ingestion' },
    action: { name: 'corpus.chunk_indexed', inputs_digest: `sha256:${'a'.repeat(64)}` },
    artifacts: { lineage_ids: [randomUUID()] },
    ...(sourceId !== undefined ? { details: { source_id: sourceId } } : {}),
  };
}

function msg(event: AuditEvent, seq: number) {
  return {
    seq,
    subject: `acp.${event.tenant}.audit.corpus.mutation`,
    data: new TextEncoder().encode(JSON.stringify(event)),
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  };
}

describe('handleCorpusMutation', () => {
  it('bumps gen.<tenant>.<source> to the stream sequence and acks', async () => {
    const kv = new FakeKv();
    const m = msg(mutation('policy-docs'), 42);
    expect(await handleCorpusMutation(m, kv, logger)).toBe('bumped');
    expect(kv.store.get('gen.acme.policy-docs')).toBe('42');
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('is advance-only: a lower (redelivered/out-of-order) sequence never regresses', async () => {
    const kv = new FakeKv();
    kv.store.set('gen.acme.policy-docs', '42');
    const m = msg(mutation('policy-docs'), 7);
    expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
    expect(kv.store.get('gen.acme.policy-docs')).toBe('42');
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('advances to a higher sequence', async () => {
    const kv = new FakeKv();
    kv.store.set('gen.acme.policy-docs', '42');
    expect(await handleCorpusMutation(msg(mutation('policy-docs'), 43), kv, logger)).toBe('bumped');
    expect(kv.store.get('gen.acme.policy-docs')).toBe('43');
  });

  it('isolates generations per tenant', async () => {
    const kv = new FakeKv();
    await handleCorpusMutation(msg(mutation('policy-docs', 'acme'), 10), kv, logger);
    await handleCorpusMutation(msg(mutation('policy-docs', 'globex'), 11), kv, logger);
    expect(kv.store.get('gen.acme.policy-docs')).toBe('10');
    expect(kv.store.get('gen.globex.policy-docs')).toBe('11');
  });

  it('ignores a mutation with no source_id (acked, no bump)', async () => {
    const kv = new FakeKv();
    const m = msg(mutation(undefined), 5);
    expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
    expect(kv.store.size).toBe(0);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('ignores a non-corpus.mutation corpus event', async () => {
    const kv = new FakeKv();
    const event = { ...mutation('policy-docs'), event_type: 'retrieval.served' } as AuditEvent;
    const m = msg(event, 6);
    expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
    expect(kv.store.size).toBe(0);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it('terminates an unparseable message (no redelivery storm)', async () => {
    const kv = new FakeKv();
    const m = {
      seq: 1,
      subject: 'acp.acme.audit.corpus.mutation',
      data: new TextEncoder().encode('{not json'),
      ack: vi.fn(),
      nak: vi.fn(),
      term: vi.fn(),
    };
    expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
    expect(m.term).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('terminates a schema-invalid event (a KV-illegal tenant is refused at the first gate)', async () => {
    const kv = new FakeKv();
    const m = {
      seq: 3,
      subject: 'acp.acme.audit.corpus.mutation',
      data: new TextEncoder().encode(
        JSON.stringify({ ...mutation('policy-docs'), tenant: 'acme.evil' }),
      ),
      ack: vi.fn(),
      nak: vi.fn(),
      term: vi.fn(),
    };
    // The audit-event schema tenant pattern forbids the dot, so parse rejects
    // it before the source ever reaches the KV — nothing is written.
    expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
    expect(kv.store.size).toBe(0);
    expect(m.term).toHaveBeenCalledOnce();
  });

  it('terminates a KV-illegal source_id instead of NAK-looping forever', async () => {
    const kv = new FakeKv();
    // A space is not a legal KV key char: kv.put would throw indistinguishably
    // from a transient fault. Park it (term), never NAK — no source-controlled
    // value can wedge the consumer in an infinite redelivery loop.
    for (const bad of ['policy docs', 'a*b', 'a>b', 'ns:src', '']) {
      const m = msg(mutation(bad), 9);
      expect(await handleCorpusMutation(m, kv, logger)).toBe('skipped');
      expect(m.term).toHaveBeenCalledOnce();
      expect(m.nak).not.toHaveBeenCalled();
      expect(m.ack).not.toHaveBeenCalled();
    }
    expect(kv.store.size).toBe(0);
  });

  it('NAKs on a transient KV failure so the bump retries', async () => {
    const kv: InvalidatorKv = {
      get: () => Promise.reject(new Error('kv down')),
      put: () => Promise.resolve(1),
    };
    const m = msg(mutation('policy-docs'), 8);
    expect(await handleCorpusMutation(m, kv, logger)).toBe('retry');
    expect(m.nak).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });
});
