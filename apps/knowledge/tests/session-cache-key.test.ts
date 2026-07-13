import { describe, expect, it } from 'vitest';
import type { PlatformClaims } from '@acp/service-kit';
import {
  CACHE_SCHEMA_VERSION,
  deriveCacheKey,
  genKey,
  permSnapshot,
  type CacheKeyInput,
} from '../src/session-cache.js';

const MODEL = 'dev-hash-embed@1';

function claims(
  overrides: Partial<PlatformClaims> = {},
): Pick<PlatformClaims, 'tenant' | 'sub' | 'act'> {
  return {
    tenant: 'acme',
    sub: 'user:jane.doe',
    act: { sub: 'agent:knowledge-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    ...overrides,
  };
}

function input(overrides: Partial<CacheKeyInput> = {}): CacheKeyInput {
  return {
    claims: claims(),
    scopes: ['knowledge:search:read'],
    classifications: ['public', 'internal'],
    embeddingModel: MODEL,
    query: 'change freeze policy',
    k: 8,
    mode: 'hybrid',
    ...overrides,
  };
}

describe('deriveCacheKey — isolation (security crux)', () => {
  it('identical effective permissions + query → identical key regardless of input order', () => {
    const a = deriveCacheKey(
      input({ scopes: ['a', 'b'], classifications: ['internal', 'public'] }),
    );
    const b = deriveCacheKey(
      input({ scopes: ['b', 'a'], classifications: ['public', 'internal'] }),
    );
    expect(a.key).toBe(b.key);
  });

  it('a different tenant yields a different key AND a different prefix', () => {
    const a = deriveCacheKey(input());
    const b = deriveCacheKey(input({ claims: claims({ tenant: 'globex' }) }));
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith('acme.')).toBe(true);
    expect(b.key.startsWith('globex.')).toBe(true);
    // Even the permission hash differs: tenant is inside the hashed snapshot too.
    expect(a.permHashHex).not.toBe(b.permHashHex);
  });

  it('a different acting principal yields a different key', () => {
    const a = deriveCacheKey(input());
    const b = deriveCacheKey(
      input({ claims: claims({ act: { sub: 'agent:other-agent@2.0.0' } }) }),
    );
    expect(a.permHashHex).not.toBe(b.permHashHex);
    expect(a.key).not.toBe(b.key);
  });

  it('narrowing a scope changes the key (no hit on the pre-narrowing entry)', () => {
    const broad = deriveCacheKey(
      input({ scopes: ['knowledge:search:read', 'knowledge:confidential:read'] }),
    );
    const narrow = deriveCacheKey(input({ scopes: ['knowledge:search:read'] }));
    expect(broad.key).not.toBe(narrow.key);
  });

  it('dropping a classification changes the key', () => {
    const broad = deriveCacheKey(
      input({ classifications: ['public', 'internal', 'confidential'] }),
    );
    const narrow = deriveCacheKey(input({ classifications: ['public', 'internal'] }));
    expect(broad.permHashHex).not.toBe(narrow.permHashHex);
  });

  it('same permissions, different query → different queryHash, same permHash', () => {
    const a = deriveCacheKey(input({ query: 'change freeze' }));
    const b = deriveCacheKey(input({ query: 'incident response' }));
    expect(a.permHashHex).toBe(b.permHashHex);
    expect(a.queryHashHex).not.toBe(b.queryHashHex);
  });

  it('query text is normalized (trim) but never appears un-hashed in the key', () => {
    const a = deriveCacheKey(input({ query: '  change freeze policy  ' }));
    const b = deriveCacheKey(input({ query: 'change freeze policy' }));
    expect(a.key).toBe(b.key);
    expect(a.key).not.toContain('change');
    // Key is exactly three dot-separated tokens: tenant + 2 hex digests.
    expect(a.key.split('.')).toHaveLength(3);
    expect(a.queryHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.permHashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('embedding-model change forks both the permission and the query hash', () => {
    const a = deriveCacheKey(input({ embeddingModel: 'dev-hash-embed@1' }));
    const b = deriveCacheKey(input({ embeddingModel: 'openai-text-embed@3' }));
    expect(a.permHashHex).not.toBe(b.permHashHex);
    expect(a.queryHashHex).not.toBe(b.queryHashHex);
  });

  it('k clamps to 50 so k=8 and k=5000 do not both need separate huge searches', () => {
    const capped = deriveCacheKey(input({ k: 5000 }));
    const fifty = deriveCacheKey(input({ k: 50 }));
    expect(capped.queryHashHex).toBe(fifty.queryHashHex);
  });

  it('source_id scoping forks the query hash', () => {
    const all = deriveCacheKey(input({ sourceId: undefined }));
    const scoped = deriveCacheKey(input({ sourceId: 'policy-docs' }));
    expect(all.queryHashHex).not.toBe(scoped.queryHashHex);
  });

  it('rejects a crafted tenant that could smuggle a KV wildcard or key family', () => {
    for (const bad of ['acme.evil', 'acme>*', 'gen.acme', '../acme', 'ACME']) {
      expect(() => deriveCacheKey(input({ claims: claims({ tenant: bad }) }))).toThrow();
    }
  });
});

describe('permSnapshot', () => {
  it('stamps the schema version and validated tenant, prefers the acting principal', () => {
    const snap = permSnapshot({
      claims: claims(),
      scopes: ['b', 'a'],
      classifications: ['internal', 'public'],
      embeddingModel: MODEL,
    });
    expect(snap.v).toBe(CACHE_SCHEMA_VERSION);
    expect(snap.tenant).toBe('acme');
    expect(snap.actor).toBe('agent:knowledge-agent@0.1.0');
    expect(snap.scopes).toEqual(['a', 'b']);
    expect(snap.classifications).toEqual(['internal', 'public']);
  });

  it('falls back to sub when there is no act chain', () => {
    const snap = permSnapshot({
      claims: { tenant: 'acme', sub: 'svc:direct' },
      scopes: [],
      classifications: ['public'],
      embeddingModel: MODEL,
    });
    expect(snap.actor).toBe('svc:direct');
  });
});

describe('genKey', () => {
  it('builds gen.<tenant>.<source_id> and validates the tenant', () => {
    expect(genKey('acme', 'policy-docs')).toBe('gen.acme.policy-docs');
    expect(() => genKey('acme.evil', 'policy-docs')).toThrow();
  });
});
