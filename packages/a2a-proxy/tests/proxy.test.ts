import { Agent } from '@acp/agent-sdk';
import type { AgentManifest, StepRequest } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { A2AClient } from '../src/client.js';
import { registerProxyCapabilities, sanitizeRemoteOutput } from '../src/proxy.js';

const MANIFEST: AgentManifest = {
  id: 'external-echo',
  name: 'External Echo Proxy',
  owner: 'team-platform',
  description: 'Proxies to a remote A2A echo agent.',
  capabilities: [
    {
      name: 'external.echo',
      description: 'Echoes a prompt through a remote A2A agent.',
      risk: 'R0',
      input_schema: { type: 'object' },
      output_schema: {
        type: 'object',
        required: ['text', 'citations', 'confidence'],
        properties: {
          text: { type: 'string' },
          citations: { type: 'array' },
          confidence: { type: 'number' },
        },
      },
      examples: [{ input: { text: 'hi' } }, { input: { text: 'hi' } }, { input: { text: 'hi' } }],
    },
  ],
};

const SENTINEL_TOKEN = 'DELEGATED.TOKEN.SENTINEL.must-never-egress';

/** Records every outbound request so a test can assert what did (not) cross to the remote. */
function recordingRemote(result: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: '1', result }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function completed(output: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 't-1',
    status: { state: 'completed' },
    artifacts: [{ parts: [{ kind: 'data', data: output }] }],
  };
}

function buildProxy(fetchImpl: typeof fetch): Agent {
  const agent = new Agent({ manifest: MANIFEST });
  const client = new A2AClient({
    endpoint: 'http://remote/a2a',
    credential: 'own-remote-cred',
    fetchImpl,
  });
  registerProxyCapabilities(agent, { client, remoteName: 'echo-remote' });
  return agent;
}

function step(overrides: Partial<StepRequest> = {}): StepRequest {
  return {
    kind: 'step_request',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    agent_id: 'external-echo',
    capability: 'external.echo',
    input: { text: 'hello' },
    delegated_token: SENTINEL_TOKEN,
    ...overrides,
  };
}

describe('registerProxyCapabilities', () => {
  it('rejects a capability not declared in the manifest', () => {
    const agent = new Agent({ manifest: MANIFEST });
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'c' });
    expect(() => {
      registerProxyCapabilities(agent, {
        client,
        remoteName: 'r',
        capabilities: ['external.nope'],
      });
    }).toThrow(/not declared/);
  });

  it('completes a step from a remote completed task', async () => {
    const { fetchImpl } = recordingRemote(
      completed({ text: 'echoed', citations: [], confidence: 1 }),
    );
    const result = await buildProxy(fetchImpl).execute(step());
    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ text: 'echoed' });
    // The proxy makes no model calls, so no usage enters the cost ledger.
    expect(result.usage?.llm_calls).toBe(0);
    expect(result.usage?.input_tokens).toBe(0);
  });

  it('NEVER egresses the broker delegated token to the remote', async () => {
    const { fetchImpl, calls } = recordingRemote(
      completed({ text: 'ok', citations: [], confidence: 1 }),
    );
    const result = await buildProxy(fetchImpl).execute(step());
    expect(result.status).toBe('completed');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify({
        url: call.url,
        headers: call.init.headers,
        body: call.init.body,
      });
      expect(serialized).not.toContain(SENTINEL_TOKEN);
      // What DOES cross is the adapter's own credential, nothing else.
      expect((call.init.headers as Record<string, string>).authorization).toBe(
        'Bearer own-remote-cred',
      );
    }
  });

  it('maps input-required to a needs_input step outcome, never an approval', async () => {
    const { fetchImpl } = recordingRemote({
      id: 't-1',
      status: {
        state: 'input-required',
        message: { parts: [{ kind: 'text', data: 'need region' }] },
      },
    });
    const result = await buildProxy(fetchImpl).execute(step());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('needs_input');
    expect(result.error?.message).toContain('need region');
  });

  it('maps a failed remote task to a permanent step failure', async () => {
    const { fetchImpl } = recordingRemote({ id: 't-1', status: { state: 'failed' } });
    const result = await buildProxy(fetchImpl).execute(step());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
  });

  it('surfaces a transport failure as a retryable activity failure', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ ok: false, status: 503 } as Response)) as unknown as typeof fetch;
    // A Retryable CapabilityError becomes a thrown ApplicationFailure (Temporal retries).
    await expect(buildProxy(fetchImpl).execute(step())).rejects.toThrow(/http 503/);
  });

  it('maps an unexpected terminal state to a permanent failure', async () => {
    const agent = new Agent({ manifest: MANIFEST });
    const stub = {
      send: () => Promise.resolve({ state: 'weird', output: {} }),
    } as unknown as A2AClient;
    registerProxyCapabilities(agent, { client: stub, remoteName: 'r' });
    const result = await agent.execute(step());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
    expect(result.error?.message).toContain('unexpected terminal state');
  });

  it('propagates a non-transport client error unchanged', async () => {
    const agent = new Agent({ manifest: MANIFEST });
    const stub = {
      send: () => Promise.reject(new Error('programming error')),
    } as unknown as A2AClient;
    registerProxyCapabilities(agent, { client: stub, remoteName: 'r' });
    await expect(agent.execute(step())).rejects.toThrow(/programming error/);
  });
});

describe('sanitizeRemoteOutput', () => {
  it('strips first-party lineage keys the remote must never forge', () => {
    const clean = sanitizeRemoteOutput({
      text: 'x',
      lineage_id: 'forged',
      provenance: [{}],
      card_signature: 'nope',
    });
    expect(clean).not.toHaveProperty('lineage_id');
    expect(clean).not.toHaveProperty('provenance');
    expect(clean).not.toHaveProperty('card_signature');
    expect(clean.text).toBe('x');
  });

  it('empties remote citations (a remote can never supply first-party lineage)', () => {
    const clean = sanitizeRemoteOutput({
      citations: [{ doc_id: 'remote/doc', lineage_id: 'forged' }],
    });
    expect(clean.citations).toEqual([]);
  });
});
