/**
 * Public A2A card edge (item 3): the /.well-known routes are unauthenticated
 * public reads that serve ONLY what the registry card source returns — the
 * signed projection or the exposed-agent index — and are disabled (404) when
 * no source is wired. RegistryA2ASource is tested with an injected fetch.
 */

import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { RegistryA2ASource, type A2ACardSource } from '../src/a2a.js';
import { buildGatewayApp, type GatewayDeps } from '../src/app.js';

const SIGNED_CARD = {
  protocolVersion: '1.0',
  name: 'External Echo',
  signatures: [{ protected: 'eyJ', signature: 'sig' }],
};
const INDEX = {
  agents: [
    {
      agent_id: 'external-echo',
      card_url: 'http://localhost:7100/v1/a2a/agents/external-echo/.well-known/agent.json',
    },
  ],
};

function buildApp(a2a?: A2ACardSource): FastifyInstance {
  const deps: GatewayDeps = {
    verifier: new JwtVerifier({ jwks: { keys: [] } }, 'https://token.test.local'),
    starter: {
      start: () => Promise.reject(new Error('unused')),
      status: () => Promise.resolve({ status: 'not_found' as const }),
      cancel: () => Promise.resolve({ outcome: 'not_found' as const }),
    },
    approvals: {
      status: () => Promise.resolve(undefined),
      decide: () => Promise.resolve(),
    },
    deployments: {
      start: () => Promise.resolve({ outcome: 'already_running' as const }),
      status: () => Promise.resolve(undefined),
      abort: () => Promise.resolve({ outcome: 'not_found' as const }),
    },
    killSwitch: { fleetHalt: () => undefined, tenantHalt: () => undefined },
    budget: {
      reserve: () => Promise.resolve('no_cap' as const),
      release: () => Promise.resolve(),
    },
    audit: { publish: () => Promise.resolve() },
    logger: createLogger('gateway-a2a-test'),
    ...(a2a === undefined ? {} : { a2a }),
  };
  return buildGatewayApp(deps);
}

const fakeSource: A2ACardSource = {
  index: () => Promise.resolve({ status: 200, body: INDEX }),
  card: (agentId: string) =>
    Promise.resolve(
      agentId === 'external-echo'
        ? { status: 200, body: SIGNED_CARD }
        : { status: 404, body: { error: { message: `no a2a card for agent ${agentId}`, status: 404 } } },
    ),
};

describe('public a2a well-known routes', () => {
  it('serves the exposed-agent index unauthenticated', async () => {
    const app = buildApp(fakeSource);
    const res = await app.inject({ method: 'GET', url: '/.well-known/agent.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(INDEX);
  });

  it('serves a signed per-agent card unauthenticated', async () => {
    const app = buildApp(fakeSource);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/a2a/agents/external-echo/.well-known/agent.json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SIGNED_CARD);
  });

  it('passes the registry 404 through for unknown agents', async () => {
    const app = buildApp(fakeSource);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/a2a/agents/nobody/.well-known/agent.json',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed agent ids without consulting the source', async () => {
    let called = false;
    const app = buildApp({
      index: () => Promise.resolve({ status: 200, body: INDEX }),
      card: () => {
        called = true;
        return Promise.resolve({ status: 200, body: SIGNED_CARD });
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/a2a/agents/${encodeURIComponent('UPPER..%2F')}/.well-known/agent.json`,
    });
    expect(res.statusCode).toBe(404);
    expect(called).toBe(false);
  });

  it('is disabled (404) when no card source is wired — the default', async () => {
    const app = buildApp();
    for (const url of [
      '/.well-known/agent.json',
      '/v1/a2a/agents/external-echo/.well-known/agent.json',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('RegistryA2ASource', () => {
  interface Call {
    url: string;
    init?: RequestInit;
  }

  function fakeFetch(calls: Call[], cardStatus = 200): typeof fetch {
    return ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      const u = String(url);
      if (u.endsWith('/v1/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'svc-token', expires_in: 600 }), {
            status: 200,
          }),
        );
      }
      if (u.includes('/v1/a2a-cards')) {
        return Promise.resolve(new Response(JSON.stringify(INDEX), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(cardStatus === 200 ? SIGNED_CARD : { error: {} }), {
          status: cardStatus,
        }),
      );
    }) as typeof fetch;
  }

  function source(calls: Call[], cardStatus = 200, ttl = 60_000): RegistryA2ASource {
    return new RegistryA2ASource({
      registryUrl: 'http://registry.test',
      tokenUrl: 'http://token.test',
      clientId: 'svc-gateway',
      clientSecret: 'secret',
      logger: createLogger('a2a-source-test'),
      cacheTtlMs: ttl,
      fetchImpl: fakeFetch(calls, cardStatus),
    });
  }

  it('fetches with its own service token and returns the signed card', async () => {
    const calls: Call[] = [];
    const s = source(calls);
    const res = await s.card('external-echo');
    expect(res).toEqual({ status: 200, body: SIGNED_CARD });
    const cardCall = calls.find((c) => c.url.endsWith('/a2a-card'));
    expect((cardCall?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer svc-token',
    );
  });

  it('caches responses within the TTL (one upstream fetch)', async () => {
    const calls: Call[] = [];
    const s = source(calls);
    await s.card('external-echo');
    await s.card('external-echo');
    await s.index();
    await s.index();
    expect(calls.filter((c) => c.url.endsWith('/a2a-card')).length).toBe(1);
    expect(calls.filter((c) => c.url.endsWith('/v1/a2a-cards')).length).toBe(1);
  });

  it('caches 404s too (enumeration is not registry load)', async () => {
    const calls: Call[] = [];
    const s = source(calls, 404);
    await s.card('nobody');
    await s.card('nobody');
    expect(calls.filter((c) => c.url.endsWith('/a2a-card')).length).toBe(1);
  });

  it('maps upstream failures to an opaque 502', async () => {
    const calls: Call[] = [];
    const s = source(calls, 500);
    const res = await s.card('external-echo');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('registry');
  });
});
