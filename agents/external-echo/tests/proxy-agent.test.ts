import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAgent, REMOTE_NAME } from '../src/agent.js';

/** A remote that returns a completed A2A task echoing the prompt, recording calls. */
function echoRemote(): { fetchImpl: typeof fetch; calls: { init: RequestInit }[] } {
  const calls: { init: RequestInit }[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    calls.push({ init });
    const body = JSON.parse(String(init.body)) as {
      params: { message: { parts: { data: unknown }[] } };
    };
    const input = body.params.message.parts[0]?.data as { text?: string };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jsonrpc: '2.0',
          id: '1',
          result: {
            id: 't-1',
            status: { state: 'completed' },
            artifacts: [
              {
                parts: [
                  {
                    kind: 'data',
                    data: { text: `echo: ${input.text ?? ''}`, citations: [], confidence: 1 },
                  },
                ],
              },
            ],
          },
        }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function step(input: Record<string, unknown>, delegatedToken: string) {
  return {
    kind: 'step_request',
    step_id: randomUUID(),
    task_id: randomUUID(),
    tenant: 'acme',
    agent_id: 'external-echo',
    capability: 'external.echo',
    input,
    delegated_token: delegatedToken,
  };
}

describe('external-echo proxy agent', () => {
  it('declares only R0/R1 capabilities (proxy convention)', () => {
    const { fetchImpl } = echoRemote();
    const agent = buildAgent({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    for (const cap of agent.manifest.capabilities) {
      expect(['R0', 'R1']).toContain(cap.risk);
    }
    expect(REMOTE_NAME).toBe('external-echo-remote');
  });

  it('builds with the default transport when no fetch seam is given', () => {
    const agent = buildAgent({ endpoint: 'http://remote/a2a', credential: 'cred' });
    expect(agent.handlers.has('external.echo')).toBe(true);
  });

  it('echoes through the remote and never egresses the delegated token', async () => {
    const { fetchImpl, calls } = echoRemote();
    const agent = buildAgent({ endpoint: 'http://remote/a2a', credential: 'own-cred', fetchImpl });
    const token = 'delegated.sentinel.NEVER_EGRESS';
    const result = await agent.execute(step({ text: 'hi' }, token));
    expect(result.status).toBe('completed');
    expect((result.output as { text: string }).text).toBe('echo: hi');
    for (const call of calls) {
      expect(JSON.stringify({ h: call.init.headers, b: call.init.body })).not.toContain(token);
      expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer own-cred');
    }
  });
});
