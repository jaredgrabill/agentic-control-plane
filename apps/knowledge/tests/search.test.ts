import type { AuditEvent } from '@acp/protocol';
import { AuthError, JwtVerifier, createLogger } from '@acp/service-kit';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HashEmbedder } from '../src/embedding.js';
import { SearchService, KNOWLEDGE_AUDIENCE, type PolicyDecision } from '../src/search.js';
import type { KnowledgeStore, SearchFilters, SearchHit } from '../src/store.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('knowledge-test');

const HIT: SearchHit = {
  lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
  source_id: 'policy-docs',
  doc_id: 'policy/change-management',
  doc_version: '3.2.0',
  title: 'Change Management Policy',
  url: 'https://docs.acme.example/policy/change-management',
  effective_date: '2026-01-15',
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

const searches: { filters: SearchFilters; queryText: string }[] = [];
const auditEvents: AuditEvent[] = [];
let policyDecision: PolicyDecision;
let policyRequests: Record<string, unknown>[] = [];

function makeService(): SearchService {
  return new SearchService({
    verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
    store: {
      existingLineage: () => Promise.resolve(undefined),
      upsertChunk: () => Promise.resolve(),
      search: (_emb, queryText, _k, filters) => {
        searches.push({ filters, queryText });
        return Promise.resolve([HIT]);
      },
    } satisfies KnowledgeStore,
    embedder: new HashEmbedder(),
    policy: {
      authorize: (req) => {
        policyRequests.push(req);
        return Promise.resolve(policyDecision);
      },
    },
    audit: {
      publish: (e) => {
        auditEvents.push(e);
        return Promise.resolve();
      },
    },
    logger,
  });
}

beforeEach(() => {
  searches.length = 0;
  auditEvents.length = 0;
  policyRequests = [];
  policyDecision = {
    decision: 'allow',
    bundle_version: '2026.07+abc',
    determining_policies: ['allow-knowledge-read'],
  };
});

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
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
    .setAudience((overrides.aud as string | undefined) ?? KNOWLEDGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

describe('SearchService', () => {
  it('verifies the delegated token, asks Cedar as the acting agent, and serves citations', async () => {
    const results = await makeService().search({
      token: await makeToken(),
      query: 'change freeze policy',
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });

    expect(policyRequests[0]).toMatchObject({
      principal: { type: 'Agent', id: 'agent:knowledge-agent@0.1.0' },
      action: 'knowledge.search',
      resource: { type: 'Corpus', id: 'acme' },
    });

    expect(results).toHaveLength(1);
    const citation = results[0]!.citation;
    expect(citation.doc_id).toBe('policy/change-management');
    expect(citation.version).toBe('3.2.0');
    expect(citation.effective_date).toBe('2026-01-15');
    expect(citation.lineage_id).toBe(HIT.lineage_id);
  });

  it('filters by the caller tenant and classification allowlist', async () => {
    await makeService().search({ token: await makeToken(), query: 'q' });
    expect(searches[0]!.filters.tenant).toBe('acme');
    expect(searches[0]!.filters.classifications).toEqual(['public', 'internal']);

    await makeService().search({
      token: await makeToken({ scope: 'knowledge:search:read knowledge:confidential:read' }),
      query: 'q',
    });
    expect(searches[1]!.filters.classifications).toContain('confidential');
  });

  it('denies on Cedar deny — no store access, actionable 403', async () => {
    policyDecision = { decision: 'deny', bundle_version: '2026.07+abc', determining_policies: [] };
    await expect(makeService().search({ token: await makeToken(), query: 'q' })).rejects.toThrow(
      /Cedar decision: deny/,
    );
    expect(searches).toHaveLength(0);
  });

  it('fails closed on require-approval — a verify-only PEP never grants an approval', async () => {
    policyDecision = {
      decision: 'require-approval',
      bundle_version: '2026.07+abc',
      determining_policies: ['gate-r2-delegation'],
    };
    await expect(makeService().search({ token: await makeToken(), query: 'q' })).rejects.toThrow(
      /require-approval/,
    );
    expect(searches).toHaveLength(0);
  });

  it('rejects wrong-audience tokens and empty queries', async () => {
    await expect(
      makeService().search({ token: await makeToken({ aud: 'acp:gateway' }), query: 'q' }),
    ).rejects.toThrow(AuthError);
    await expect(makeService().search({ token: await makeToken(), query: '  ' })).rejects.toThrow(
      /query is required/,
    );
  });

  it('records retrieval.served with the exact lineage_ids and delegation chain', async () => {
    await makeService().search({
      token: await makeToken(),
      query: 'change freeze',
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.event_type).toBe('retrieval.served');
    expect(event.artifacts?.lineage_ids).toEqual([HIT.lineage_id]);
    expect(event.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:knowledge-agent@0.1.0',
    ]);
    expect(event.reason?.policy?.determining_policies).toEqual(['allow-knowledge-read']);
  });

  it('still serves results when the audit sink fails (R0 alarm-and-continue)', async () => {
    const service = new SearchService({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
      store: {
        existingLineage: () => Promise.resolve(undefined),
        upsertChunk: () => Promise.resolve(),
        search: () => Promise.resolve([HIT]),
      },
      embedder: new HashEmbedder(),
      policy: { authorize: () => Promise.resolve(policyDecision) },
      audit: { publish: () => Promise.reject(new Error('stream down')) },
      logger,
    });
    const results = await service.search({ token: await makeToken(), query: 'q' });
    expect(results).toHaveLength(1);
  });

  it('caps k at 50', async () => {
    const service = new SearchService({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
      store: {
        existingLineage: () => Promise.resolve(undefined),
        upsertChunk: () => Promise.resolve(),
        search: vi.fn((_e, _q, k: number) => {
          expect(k).toBe(50);
          return Promise.resolve([]);
        }),
      },
      embedder: new HashEmbedder(),
      policy: { authorize: () => Promise.resolve(policyDecision) },
      audit: { publish: () => Promise.resolve() },
      logger,
    });
    await service.search({ token: await makeToken(), query: 'q', k: 5000 });
  });
});
