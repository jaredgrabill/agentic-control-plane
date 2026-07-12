import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUS_AUDIENCE, BusTokenSource } from '../src/bus-token.js';

type ScriptedResponse = { status: number; body: unknown } | 'network-error';

/** A fetch stub that returns scripted responses in sequence. */
function fetchScript(responses: ScriptedResponse[]): {
  impl: typeof fetch;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const impl = ((_url: string, init?: { body?: string }) => {
    calls.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    const r = responses[Math.min(i, responses.length - 1)] ?? 'network-error';
    i += 1;
    if (r === 'network-error') return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(JSON.stringify(r.body)),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BusTokenSource.mint', () => {
  it('mints an acp:bus token with client_credentials against the agent client', async () => {
    const { impl, calls } = fetchScript([
      { status: 200, body: { access_token: 'bus-tok', expires_in: 600 } },
    ]);
    const source = new BusTokenSource({
      tokenUrl: 'http://token.local',
      clientId: 'agent-knowledge-agent',
      clientSecret: 'sekret',
      fetchImpl: impl,
    });
    const { token, expiresIn } = await source.mint();
    expect(token).toBe('bus-tok');
    expect(expiresIn).toBe(600);
    expect(calls[0]).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'agent-knowledge-agent',
      client_secret: 'sekret',
      audience: BUS_AUDIENCE,
    });
  });

  it('throws on a non-2xx mint', async () => {
    const { impl } = fetchScript([{ status: 403, body: { error: 'suspended' } }]);
    const source = new BusTokenSource({
      tokenUrl: 'http://token.local',
      clientId: 'agent-x',
      clientSecret: 's',
      fetchImpl: impl,
    });
    await expect(source.mint()).rejects.toThrow(/403/);
  });
});

describe('BusTokenSource.start / refresh', () => {
  it('token() throws before start(), returns the minted token after', async () => {
    const { impl } = fetchScript([{ status: 200, body: { access_token: 't1', expires_in: 600 } }]);
    const source = new BusTokenSource({
      tokenUrl: 'http://token.local',
      clientId: 'agent-x',
      clientSecret: 's',
      fetchImpl: impl,
    });
    expect(() => source.token()).toThrow(/not yet minted/);
    await source.start();
    expect(source.token()).toBe('t1');
    source.stop();
  });

  it('retries the initial mint through the boot race, then succeeds', async () => {
    const { impl, calls } = fetchScript([
      'network-error',
      { status: 200, body: { access_token: 't-ok', expires_in: 600 } },
    ]);
    const source = new BusTokenSource({
      tokenUrl: 'http://token.local',
      clientId: 'agent-x',
      clientSecret: 's',
      fetchImpl: impl,
      maxBackoffMs: 1,
    });
    await source.start();
    expect(source.token()).toBe('t-ok');
    expect(calls.length).toBe(2);
    source.stop();
  });

  it('re-mints at ~2/3 TTL and rotates the current token', async () => {
    vi.useFakeTimers();
    const { impl } = fetchScript([
      { status: 200, body: { access_token: 't1', expires_in: 300 } },
      { status: 200, body: { access_token: 't2', expires_in: 300 } },
    ]);
    const source = new BusTokenSource({
      tokenUrl: 'http://token.local',
      clientId: 'agent-x',
      clientSecret: 's',
      fetchImpl: impl,
    });
    await source.start();
    expect(source.token()).toBe('t1');
    // Refresh scheduled at 300 * 2/3 = 200s.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(source.token()).toBe('t2');
    source.stop();
  });
});
