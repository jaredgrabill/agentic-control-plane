import { describe, expect, it } from 'vitest';
import { HttpPolicyClient } from '../src/policy-client.js';

const REQUEST = {
  principal: { type: 'Agent', id: 'agent:cloud-agent@0.1.0', attrs: { tenant: 'acme' } },
  action: 'tool:cloud-estate:inventory_search',
  resource: { type: 'Service', id: 'svc:cloud-estate', attrs: {} },
  context: { scopes: ['cloud:inventory:read'], tenant: 'acme' },
};

describe('HttpPolicyClient', () => {
  it('mints a policy:decide token then posts the authorization request', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth?: string | undefined }[] = [];
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
        auth: headers.authorization,
      });
      if (String(url).endsWith('/v1/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'decide-token' }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            decision: 'allow',
            bundle_version: '2026.07+abc',
            determining_policies: ['allow-tool-cloud-estate-inventory'],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;

    const client = new HttpPolicyClient({
      policyUrl: 'http://localhost:7103',
      tokenUrl: 'http://localhost:7101',
      clientId: 'svc-tool-gateway',
      clientSecret: 'tool-gateway-dev-secret',
      fetchImpl,
    });
    const decision = await client.authorize(REQUEST);
    expect(decision.decision).toBe('allow');
    expect(decision.determining_policies).toEqual(['allow-tool-cloud-estate-inventory']);

    expect(calls[0]!.url).toBe('http://localhost:7101/v1/token');
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'client_credentials',
      audience: 'acp:policy',
      scope: 'policy:decide',
    });
    expect(calls[1]!.url).toBe('http://localhost:7103/v1/authorize');
    expect(calls[1]!.auth).toBe('Bearer decide-token');
    expect(calls[1]!.body).toMatchObject(REQUEST);
  });

  it('fails loudly when the token service or the PDP refuses', async () => {
    const refuseToken = (() =>
      Promise.resolve(new Response('nope', { status: 401 }))) as typeof fetch;
    await expect(
      new HttpPolicyClient({
        policyUrl: 'p',
        tokenUrl: 't',
        clientId: 'c',
        clientSecret: 's',
        fetchImpl: refuseToken,
      }).authorize(REQUEST),
    ).rejects.toThrow(/token service refused tool-gateway client: 401/);

    const refusePdp = ((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? Promise.resolve(new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }))
        : Promise.resolve(new Response('bundle broken', { status: 500 }))) as typeof fetch;
    await expect(
      new HttpPolicyClient({
        policyUrl: 'p',
        tokenUrl: 't',
        clientId: 'c',
        clientSecret: 's',
        fetchImpl: refusePdp,
      }).authorize(REQUEST),
    ).rejects.toThrow(/policy service failed: 500 bundle broken/);
  });
});
