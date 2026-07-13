import { createLogger } from '@acp/service-kit';
import { describe, expect, it } from 'vitest';
import {
  SessionCacheControl,
  SessionContextCache,
  validateEntry,
  type SessionCacheEntry,
  type SessionCacheKv,
  type SessionCachePurgeKv,
} from '../src/session-cache.js';

const logger = createLogger('session-cache-store-test');

/**
 * In-memory KV fake matching the narrow SessionCacheKv surface. Models NATS
 * delete tombstones: a deleted key is not absent — a subsequent get returns the
 * tombstone entry (operation DEL, empty value), exactly like nats@2 kv.get.
 */
class FakeKv implements SessionCacheKv {
  readonly store = new Map<string, string>();
  readonly tombstones = new Set<string>();
  putCalls = 0;
  failGet = false;
  failPut = false;

  get(key: string): Promise<{ string(): string; operation?: string } | null> {
    if (this.failGet) return Promise.reject(new Error('kv down'));
    if (this.tombstones.has(key)) return Promise.resolve({ string: () => '', operation: 'DEL' });
    const v = this.store.get(key);
    return Promise.resolve(v === undefined ? null : { string: () => v });
  }
  put(key: string, value: string): Promise<number> {
    this.putCalls += 1;
    if (this.failPut) return Promise.reject(new Error('kv down'));
    this.store.set(key, value);
    this.tombstones.delete(key);
    return Promise.resolve(1);
  }
  delete(key: string): Promise<void> {
    this.store.delete(key);
    this.tombstones.add(key);
    return Promise.resolve();
  }
}

function entry(overrides: Partial<SessionCacheEntry> = {}): SessionCacheEntry {
  return {
    v: 1,
    tenant: 'acme',
    perm_hash: 'p'.repeat(64),
    query_hash: 'q'.repeat(64),
    results: [
      {
        content: 'A change freeze is in effect.',
        score: 0.5,
        citation: {
          doc_id: 'policy/cm',
          version: '3.2.0',
          lineage_id: 'lin-1',
          snippet: 'A change freeze',
        },
      },
    ],
    sources: ['policy-docs'],
    gens: { 'policy-docs': '7' },
    lineage_ids: ['lin-1'],
    written_at: new Date().toISOString(),
    expires_at: Date.now() + 60_000,
    ...overrides,
  };
}

describe('SessionContextCache store', () => {
  it('round-trips an entry through put → get', async () => {
    const kv = new FakeKv();
    const cache = new SessionContextCache(kv, 262_144, logger);
    expect(await cache.put('k', entry())).toBe('ok');
    const got = await cache.get('k');
    expect(got?.results[0]?.citation.lineage_id).toBe('lin-1');
    expect(got?.gens['policy-docs']).toBe('7');
  });

  it('returns undefined for an absent key', async () => {
    const cache = new SessionContextCache(new FakeKv(), 262_144, logger);
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('skips oversize writes rather than truncating (serves live, uncached)', async () => {
    const kv = new FakeKv();
    const cache = new SessionContextCache(kv, 64, logger); // tiny cap
    expect(await cache.put('k', entry())).toBe('too_large');
    expect(kv.putCalls).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  it('degrades to a miss when the KV get throws', async () => {
    const kv = new FakeKv();
    kv.failGet = true;
    const cache = new SessionContextCache(kv, 262_144, logger);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('reports a write failure without throwing', async () => {
    const kv = new FakeKv();
    kv.failPut = true;
    const cache = new SessionContextCache(kv, 262_144, logger);
    expect(await cache.put('k', entry())).toBe('error');
  });

  it('treats an unparseable stored value as a miss', async () => {
    const kv = new FakeKv();
    kv.store.set('k', '{not json');
    const cache = new SessionContextCache(kv, 262_144, logger);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('a read after evict sees the tombstone as a miss (not a phantom KV failure)', async () => {
    const kv = new FakeKv();
    const cache = new SessionContextCache(kv, 262_144, logger);
    await cache.put('k', entry());
    await cache.evict('k');
    // The key now holds a DEL tombstone (empty value); get() must treat it as a
    // clean miss rather than JSON.parse('') throwing and logging a fake fault.
    expect(kv.store.has('k')).toBe(false);
    expect(kv.tombstones.has('k')).toBe(true);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('evicts a key, and a delete failure is swallowed', async () => {
    const kv = new FakeKv();
    const cache = new SessionContextCache(kv, 262_144, logger);
    await cache.put('k', entry());
    await cache.evict('k');
    expect(kv.store.has('k')).toBe(false);
    // A throwing delete must not surface on the hot path.
    const throwing = new SessionContextCache(
      {
        get: kv.get.bind(kv),
        put: kv.put.bind(kv),
        delete: () => Promise.reject(new Error('kv down')),
      },
      262_144,
      logger,
    );
    await expect(throwing.evict('k')).resolves.toBeUndefined();
  });
});

const expected = { tenant: 'acme', permHashHex: 'p'.repeat(64), queryHashHex: 'q'.repeat(64) };
const genOk = (t: string, s: string): string => (t === 'acme' && s === 'policy-docs' ? '7' : '0');

describe('validateEntry', () => {
  it('accepts a fresh, matching, current entry', () => {
    expect(validateEntry(entry(), expected, genOk, Date.now())).toEqual({ ok: true });
  });

  it('rejects an expired entry (proves TTL is enforced on read)', () => {
    const now = 1_000_000;
    const e = entry({ expires_at: now - 1 });
    expect(validateEntry(e, expected, genOk, now)).toEqual({ ok: false, reason: 'expired' });
  });

  it('expires_at = min(now+ttl, tokenExp*1000) can never exceed the token — a token-bound entry expires with the token', () => {
    const now = 1_000_000;
    const ttlMs = 60_000;
    const tokenExpSec = 1_010; // 1_010_000 ms < now+ttl (1_060_000)
    const expiresAt = Math.min(now + ttlMs, tokenExpSec * 1000);
    expect(expiresAt).toBe(1_010_000);
    // At token expiry the entry is already a miss.
    expect(
      validateEntry(entry({ expires_at: expiresAt }), expected, genOk, 1_010_000),
    ).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a tenant/perm/query mismatch (paranoia re-check of the key parts)', () => {
    const now = Date.now();
    expect(validateEntry(entry({ tenant: 'globex' }), expected, genOk, now)).toMatchObject({
      reason: 'tenant_mismatch',
    });
    expect(validateEntry(entry({ perm_hash: 'x'.repeat(64) }), expected, genOk, now)).toMatchObject(
      {
        reason: 'perm_mismatch',
      },
    );
    expect(
      validateEntry(entry({ query_hash: 'x'.repeat(64) }), expected, genOk, now),
    ).toMatchObject({
      reason: 'query_mismatch',
    });
  });

  it('rejects an entry whose captured source generation no longer matches (lineage evict)', () => {
    const stale = (t: string, s: string): string => (s === 'policy-docs' ? '8' : '0'); // bumped 7 → 8
    const res = validateEntry(entry(), expected, stale, Date.now());
    expect(res).toEqual({ ok: false, reason: 'stale', source_id: 'policy-docs' });
  });

  it('treats a wiped generation view (source now unknown → 0) as stale, not fresh', () => {
    const wiped = (): string => '0';
    expect(validateEntry(entry(), expected, wiped, Date.now())).toMatchObject({ reason: 'stale' });
  });
});

describe('SessionCacheControl.purgeTenant', () => {
  class PurgeKv implements SessionCachePurgeKv {
    readonly store = new Set<string>();
    readonly purged: string[] = [];
    keys(filter?: string | string[]): Promise<AsyncIterable<string>> {
      const f = String(filter).replace('.>', '.');
      const matches = [...this.store].filter((k) => k.startsWith(f));
      return Promise.resolve(
        (async function* () {
          await Promise.resolve();
          for (const k of matches) yield k;
        })(),
      );
    }
    purge(key: string): Promise<void> {
      this.purged.push(key);
      this.store.delete(key);
      return Promise.resolve();
    }
  }

  it('purges only the tenant entry keys, not generations or other tenants', async () => {
    const kv = new PurgeKv();
    kv.store.add('ctx.acme.aaa.bbb');
    kv.store.add('ctx.acme.ccc.ddd');
    kv.store.add('ctx.globex.eee.fff');
    kv.store.add('gen.acme.policy-docs');
    const control = new SessionCacheControl(kv);
    const count = await control.purgeTenant('acme');
    expect(count).toBe(2);
    expect(kv.store.has('ctx.globex.eee.fff')).toBe(true);
    expect(kv.store.has('gen.acme.policy-docs')).toBe(true);
  });

  it('rejects a KV-illegal tenant', async () => {
    await expect(new SessionCacheControl(new PurgeKv()).purgeTenant('acme.evil')).rejects.toThrow();
  });
});
