import type { AgentCard, EvalBaseline } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { recordBaseline } from '../src/registry-client.js';

const BASELINE: EvalBaseline = {
  schema: 'acp-eval-baseline/v1',
  agent_id: 'knowledge-agent',
  agent_version: '0.1.0',
  metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
  suite: { digest: `sha256:${'e'.repeat(64)}`, case_count: 7 },
  harness: 'acp-agent-sdk-py@0.1.0',
  recorded_at: '2026-07-11T09:00:00Z',
};

const CARD: AgentCard = {
  manifest: {
    id: 'knowledge-agent',
    name: 'Knowledge & Policy Agent',
    owner: 'team-platform',
    description: 'Cited answers over the governed corpus.',
    capabilities: [
      {
        name: 'knowledge.search',
        description: 'Hybrid search.',
        risk: 'R0',
        input_schema: {},
        output_schema: {},
        examples: [{ input: {} }, { input: {} }, { input: {} }],
      },
    ],
  },
  version: '0.1.0',
  lifecycle_state: 'active',
  eval_baseline: BASELINE,
  registered_at: '2026-07-10T08:00:00Z',
  updated_at: '2026-07-11T09:00:01Z',
  card_signature: 'jws',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('recordBaseline', () => {
  it('mints a registry:write token then PUTs the baseline to the agent card', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return Promise.resolve(jsonResponse(200, { access_token: 'tok-1' }));
      return Promise.resolve(jsonResponse(200, CARD));
    }) as unknown as typeof fetch;

    const card = await recordBaseline({
      registryUrl: 'http://registry.local:7102',
      tokenUrl: 'http://token.local:7101',
      clientId: 'svc-ci',
      clientSecret: 'ci-dev-secret',
      baseline: BASELINE,
      fetchImpl,
    });
    expect(card).toEqual(CARD);

    expect(calls[0]?.url).toBe('http://token.local:7101/v1/token');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'svc-ci',
      client_secret: 'ci-dev-secret',
      audience: 'acp:registry',
      scope: 'registry:write',
    });

    expect(calls[1]?.url).toBe('http://registry.local:7102/v1/agents/knowledge-agent/baseline');
    expect(calls[1]?.init.method).toBe('PUT');
    expect(calls[1]?.init.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual(BASELINE);
  });

  it('throws with status and body when the token mint is refused', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('bad client', { status: 401 }))) as unknown as typeof fetch;
    await expect(
      recordBaseline({
        registryUrl: 'http://registry.local:7102',
        tokenUrl: 'http://token.local:7101',
        clientId: 'svc-ci',
        clientSecret: 'nope',
        baseline: BASELINE,
        fetchImpl,
      }),
    ).rejects.toThrow('token request failed (401): bad client');
  });

  it('throws with status and body when the registry rejects the baseline', async () => {
    let call = 0;
    const fetchImpl = (() => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse(200, { access_token: 'tok-1' }));
      return Promise.resolve(
        new Response('{"error":{"message":"baseline is for version 0.2.0"}}', { status: 409 }),
      );
    }) as unknown as typeof fetch;
    await expect(
      recordBaseline({
        registryUrl: 'http://registry.local:7102',
        tokenUrl: 'http://token.local:7101',
        clientId: 'svc-ci',
        clientSecret: 'ci-dev-secret',
        baseline: BASELINE,
        fetchImpl,
      }),
    ).rejects.toThrow('baseline record failed (409)');
  });
});
