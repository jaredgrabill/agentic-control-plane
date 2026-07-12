import { describe, expect, it } from 'vitest';
import { RegistryAllowlist, RegistryUnavailableError } from '../src/allowlist.js';

const tokenResponse = () => new Response(JSON.stringify({ access_token: 'gw-token' }));

function cardResponse(allowed?: string[]): Response {
  return new Response(
    JSON.stringify({
      manifest: {
        id: 'cloud-agent',
        ...(allowed !== undefined ? { models: { allowed } } : {}),
      },
      version: '0.1.0',
      lifecycle_state: 'active',
    }),
  );
}

interface Call {
  url: string;
  authorization: string | undefined;
}

function allowlistWith(
  respond: (url: string) => Response | Promise<Response>,
  options: { ttlMs?: number; now?: () => number } = {},
): { allowlist: RegistryAllowlist; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return Promise.resolve(respond(url));
  };
  const allowlist = new RegistryAllowlist({
    registryUrl: 'http://registry.test',
    tokenUrl: 'http://token.test',
    clientId: 'svc-llm-gateway',
    clientSecret: 'secret',
    fetchImpl,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { allowlist, calls };
}

const respondHappy = (allowed?: string[]) => (url: string) =>
  url.includes('/v1/token') ? tokenResponse() : cardResponse(allowed);

describe('RegistryAllowlist', () => {
  it('allows a class the card declares and denies one it does not', async () => {
    const { allowlist, calls } = allowlistWith(respondHappy(['default-tier']));
    const allowed = await allowlist.check('cloud-agent', 'default-tier');
    expect(allowed).toEqual({ allowed: true, allowedClasses: ['default-tier'] });
    const denied = await allowlist.check('cloud-agent', 'reasoning-tier');
    expect(denied.allowed).toBe(false);
    // Card fetch used the gateway's OWN minted token, never the caller's.
    const cardCall = calls.find((c) => c.url.includes('/v1/agents/cloud-agent'));
    expect(cardCall?.authorization).toBe('Bearer gw-token');
  });

  it('denies every class when the card has no models block', async () => {
    const { allowlist } = allowlistWith(respondHappy(undefined));
    const result = await allowlist.check('cloud-agent', 'default-tier');
    expect(result).toEqual({ allowed: false, allowedClasses: [] });
  });

  it('denies (not 503) for an unregistered agent — a 404 is a deterministic answer', async () => {
    const { allowlist } = allowlistWith((url) =>
      url.includes('/v1/token') ? tokenResponse() : new Response('not found', { status: 404 }),
    );
    const result = await allowlist.check('ghost-agent', 'default-tier');
    expect(result.allowed).toBe(false);
  });

  it('caches the card for the TTL and refetches after it lapses', async () => {
    let clock = 0;
    const { allowlist, calls } = allowlistWith(respondHappy(['default-tier']), {
      ttlMs: 30_000,
      now: () => clock,
    });
    await allowlist.check('cloud-agent', 'default-tier');
    await allowlist.check('cloud-agent', 'reasoning-tier');
    await allowlist.check('cloud-agent', 'default-tier');
    const cardCalls = () => calls.filter((c) => c.url.includes('/v1/agents/')).length;
    expect(cardCalls()).toBe(1);

    clock = 30_001;
    await allowlist.check('cloud-agent', 'default-tier');
    expect(cardCalls()).toBe(2);
  });

  it('fails closed on a registry outage: 5xx, network, and token refusals all throw', async () => {
    const fiveHundred = allowlistWith((url) =>
      url.includes('/v1/token') ? tokenResponse() : new Response('boom', { status: 500 }),
    );
    await expect(fiveHundred.allowlist.check('cloud-agent', 'default-tier')).rejects.toThrow(
      RegistryUnavailableError,
    );

    const unreachable = new RegistryAllowlist({
      registryUrl: 'http://registry.test',
      tokenUrl: 'http://token.test',
      clientId: 'svc-llm-gateway',
      clientSecret: 'secret',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(unreachable.check('cloud-agent', 'default-tier')).rejects.toThrow(
      /token service refused/,
    );

    const tokenDenied = allowlistWith((url) =>
      url.includes('/v1/token')
        ? new Response('denied', { status: 403 })
        : cardResponse(['default-tier']),
    );
    await expect(tokenDenied.allowlist.check('cloud-agent', 'default-tier')).rejects.toThrow(
      RegistryUnavailableError,
    );
  });

  it('does not cache failures — the next call retries the registry', async () => {
    let healthy = false;
    const { allowlist, calls } = allowlistWith((url) => {
      if (url.includes('/v1/token')) return tokenResponse();
      return healthy ? cardResponse(['default-tier']) : new Response('down', { status: 503 });
    });
    await expect(allowlist.check('cloud-agent', 'default-tier')).rejects.toThrow(
      RegistryUnavailableError,
    );
    healthy = true;
    const result = await allowlist.check('cloud-agent', 'default-tier');
    expect(result.allowed).toBe(true);
    expect(calls.filter((c) => c.url.includes('/v1/agents/')).length).toBe(2);
  });
});
