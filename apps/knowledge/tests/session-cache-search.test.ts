import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HashEmbedder } from '../src/embedding.js';
import {
  SearchService,
  KNOWLEDGE_AUDIENCE,
  type CachePort,
  type GenerationsPort,
  type KillSwitchPort,
  type PolicyDecision,
} from '../src/search.js';
import type { SessionCacheEntry } from '../src/session-cache.js';
import type { KnowledgeStore, SearchFilters, SearchHit } from '../src/store.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('session-cache-search-test');

const HIT: SearchHit = {
  lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
  source_id: 'policy-docs',
  doc_id: 'policy/change-management',
  doc_version: '3.2.0',
  title: 'Change Management Policy',
  url: null,
  effective_date: null,
  classification: 'internal',
  content: 'A change freeze is in effect during the final week of each fiscal quarter.',
  score: 0.032,
};

let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  key = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);
});

class FakeCache implements CachePort {
  readonly store = new Map<string, SessionCacheEntry>();
  readonly getKeys: string[] = [];
  readonly putKeys: string[] = [];
  readonly evictKeys: string[] = [];
  get(k: string): Promise<SessionCacheEntry | undefined> {
    this.getKeys.push(k);
    return Promise.resolve(this.store.get(k));
  }
  put(k: string, entry: SessionCacheEntry): Promise<'ok'> {
    this.putKeys.push(k);
    this.store.set(k, entry);
    return Promise.resolve('ok');
  }
  evict(k: string): Promise<void> {
    this.evictKeys.push(k);
    this.store.delete(k);
    return Promise.resolve();
  }
}

class FakeGens implements GenerationsPort {
  readonly gens = new Map<string, string>();
  ready = true;
  current(tenant: string, source: string): string {
    return this.gens.get(`${tenant}/${source}`) ?? '0';
  }
  isReady(): boolean {
    return this.ready;
  }
}

class FakeKillSwitch implements KillSwitchPort {
  fleet = false;
  tenants = new Set<string>();
  denied = new Set<string>();
  fleetHalt(): unknown {
    return this.fleet ? { active: true } : undefined;
  }
  tenantHalt(tenant: string): unknown {
    return this.tenants.has(tenant) ? { active: true } : undefined;
  }
  principalDenied(sub: string): unknown {
    return this.denied.has(sub) ? { active: true } : undefined;
  }
}

let searchCalls = 0;
let cache: FakeCache;
let gens: FakeGens;
let killSwitch: FakeKillSwitch;
let auditEvents: AuditEvent[];
let policyRequests: number;
let clock: number;

beforeEach(() => {
  searchCalls = 0;
  cache = new FakeCache();
  gens = new FakeGens();
  killSwitch = new FakeKillSwitch();
  auditEvents = [];
  policyRequests = 0;
  clock = Date.now(); // anchor to real time: jose verifies token exp against the wall clock
});

function makeService(
  overrides: { withCache?: boolean; withKillSwitch?: boolean } = {},
): SearchService {
  const store: KnowledgeStore = {
    existingLineage: () => Promise.resolve(undefined),
    upsertChunk: () => Promise.resolve(),
    search: (_emb, _q, _k, _f: SearchFilters) => {
      searchCalls += 1;
      return Promise.resolve([HIT]);
    },
  };
  return new SearchService({
    verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
    store,
    embedder: new HashEmbedder(),
    policy: {
      authorize: (): Promise<PolicyDecision> => {
        policyRequests += 1;
        return Promise.resolve({
          decision: 'allow',
          bundle_version: '2026.07+abc',
          determining_policies: ['allow-knowledge-read'],
        });
      },
    },
    audit: {
      publish: (e) => {
        auditEvents.push(e);
        return Promise.resolve();
      },
    },
    logger,
    now: () => new Date(clock),
    ...(overrides.withCache !== false ? { cache, gens } : {}),
    ...(overrides.withKillSwitch ? { killSwitch } : {}),
    cacheTtlMs: 60_000,
  });
}

async function token(overrides: Record<string, unknown> = {}, expSeconds = 3600): Promise<string> {
  return new SignJWT({
    sub: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: 'knowledge:search:read',
    act: { sub: 'agent:knowledge-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(KNOWLEDGE_AUDIENCE)
    .setIssuedAt(Math.floor(clock / 1000))
    .setExpirationTime(Math.floor(clock / 1000) + expSeconds)
    .sign(key);
}

const lastCache = (): unknown =>
  (auditEvents.at(-1)?.details as { cache?: string } | undefined)?.cache;

describe('SearchService session cache', () => {
  it('serves the same query twice: first a miss+write, second a hit (no second store search)', async () => {
    const svc = makeService();
    const t = await token();
    const first = await svc.search({ token: t, query: 'change freeze policy' });
    expect(searchCalls).toBe(1);
    expect(cache.putKeys).toHaveLength(1);
    expect(lastCache()).toBe('miss');

    const second = await svc.search({ token: await token(), query: 'change freeze policy' });
    expect(searchCalls).toBe(1); // no live search on the hit
    expect(second).toEqual(first);
    expect(lastCache()).toBe('hit');
    // Authorization re-ran on the hit (verify + Cedar are never cached).
    expect(policyRequests).toBe(2);
    // Both retrieval.served events carry the same served lineage_ids.
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]?.artifacts?.lineage_ids).toEqual(auditEvents[1]?.artifacts?.lineage_ids);
  });

  it('permission narrowing does not hit the broader entry (different key)', async () => {
    const svc = makeService();
    await svc.search({
      token: await token({ scope: 'knowledge:search:read knowledge:confidential:read' }),
      query: 'q',
    });
    const broadKey = cache.putKeys[0]!;
    // Same query, a narrower scope → a different permission snapshot → different key.
    await svc.search({ token: await token({ scope: 'knowledge:search:read' }), query: 'q' });
    expect(searchCalls).toBe(2); // second call missed → live search
    expect(cache.getKeys.at(-1)).not.toBe(broadKey);
  });

  it('isolates principals: principal B never reads principal A entry', async () => {
    const svc = makeService();
    await svc.search({ token: await token(), query: 'q' });
    const aKey = cache.putKeys[0]!;
    // A different acting principal (act.sub) → different key → miss.
    await svc.search({
      token: await token({ act: { sub: 'agent:other-agent@9.9.9' } }),
      query: 'q',
    });
    expect(cache.getKeys.at(-1)).not.toBe(aKey);
    expect(searchCalls).toBe(2);
  });

  it('evicts and misses when a source generation changes (lineage invalidation)', async () => {
    const svc = makeService();
    await svc.search({ token: await token(), query: 'q' }); // writes entry at gen 0
    expect(searchCalls).toBe(1);
    // The corpus mutates: its generation is bumped.
    gens.gens.set('acme/policy-docs', '5');
    await svc.search({ token: await token(), query: 'q' });
    expect(searchCalls).toBe(2); // stale → miss → live
    expect(cache.evictKeys).toHaveLength(1);
    expect(lastCache()).toBe('miss');
  });

  it('expires an entry once the TTL passes and never beyond the token', async () => {
    const svc = makeService();
    await svc.search({ token: await token(), query: 'q' });
    const entry = [...cache.store.values()][0]!;
    // expires_at is clamped: min(now+ttl, tokenExp). With ttl 60s < token 3600s → now+60s.
    expect(entry.expires_at).toBe(clock + 60_000);
    // Advance past the TTL; the cached entry is now expired.
    clock += 60_001;
    await svc.search({ token: await token(), query: 'q' });
    expect(searchCalls).toBe(2);
    expect(cache.evictKeys).toHaveLength(1);
  });

  it('clamps expires_at to the token when the token expires before the TTL', async () => {
    const svc = makeService();
    await svc.search({ token: await token({}, 10), query: 'q' }); // token lives 10s < 60s ttl
    const entry = [...cache.store.values()][0]!;
    // The token exp is whole-second (JWT), so the clamp lands on the token's
    // second boundary — but it is bounded ABOVE by now+ttl and equals the token.
    const tokenExpMs = (Math.floor(clock / 1000) + 10) * 1000;
    expect(entry.expires_at).toBe(tokenExpMs);
    expect(entry.expires_at).toBeLessThan(clock + 60_000);
  });

  it('bypasses the cache under a fleet halt (no read, no write, no cache marker)', async () => {
    const svc = makeService({ withKillSwitch: true });
    killSwitch.fleet = true;
    await svc.search({ token: await token(), query: 'q' });
    expect(cache.getKeys).toHaveLength(0);
    expect(cache.putKeys).toHaveLength(0);
    expect(searchCalls).toBe(1);
    expect(lastCache()).toBeUndefined();
  });

  it('bypasses the cache under a tenant halt and a principal denial', async () => {
    const svc = makeService({ withKillSwitch: true });
    killSwitch.tenants.add('acme');
    await svc.search({ token: await token(), query: 'q' });
    expect(cache.getKeys).toHaveLength(0);

    killSwitch.tenants.clear();
    killSwitch.denied.add('agent:knowledge-agent@0.1.0');
    await svc.search({ token: await token(), query: 'q' });
    expect(cache.getKeys).toHaveLength(0);
    expect(searchCalls).toBe(2);
  });

  it('disables itself until the generation view is seeded (fail-safe)', async () => {
    const svc = makeService();
    gens.ready = false;
    await svc.search({ token: await token(), query: 'q' });
    expect(cache.getKeys).toHaveLength(0);
    expect(cache.putKeys).toHaveLength(0);
    expect(searchCalls).toBe(1);
  });

  it('captures the write-time generation so a later bump invalidates it', async () => {
    const svc = makeService();
    gens.gens.set('acme/policy-docs', '3');
    await svc.search({ token: await token(), query: 'q' });
    const entry = [...cache.store.values()][0]!;
    expect(entry.gens['policy-docs']).toBe('3');
    expect(entry.sources).toEqual(['policy-docs']);
    expect(entry.lineage_ids).toEqual([HIT.lineage_id]);
  });
});
