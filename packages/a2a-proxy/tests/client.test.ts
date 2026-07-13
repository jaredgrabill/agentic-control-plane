import { describe, expect, it } from 'vitest';
import { A2AClient, A2ATimeoutError, A2ATransportError } from '../src/client.js';

/** A fetch stub that returns a JSON-RPC 200 with the given result, recording calls. */
function jsonRpcFetch(results: unknown[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: '1', result }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function task(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 't-1', status: { state }, ...extra };
}

const SEND = {
  capability: 'external.echo',
  input: { text: 'hi' },
  taskId: 'task-1',
  stepId: 'step-1',
};
const noSleep = (): Promise<void> => Promise.resolve();

describe('A2AClient.send', () => {
  it('returns immediately on a terminal message/send response', async () => {
    const { fetchImpl, calls } = jsonRpcFetch([
      task('completed', { artifacts: [{ parts: [{ kind: 'data', data: { text: 'echoed' } }] }] }),
    ]);
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    const view = await client.send(SEND);
    expect(view.state).toBe('completed');
    expect(view.output).toEqual({ text: 'echoed' });
    // Exactly one call: no polling when the first response is already terminal.
    expect(calls).toHaveLength(1);
  });

  it('polls tasks/get until a terminal state', async () => {
    const { fetchImpl, calls } = jsonRpcFetch([
      task('working'),
      task('working'),
      task('completed', { artifacts: [{ parts: [{ kind: 'data', data: { ok: true } }] }] }),
    ]);
    const client = new A2AClient({
      endpoint: 'http://remote/a2a',
      credential: 'cred',
      fetchImpl,
      pollIntervalMs: 0,
      sleep: noSleep,
    });
    const view = await client.send(SEND);
    expect(view.state).toBe('completed');
    expect(view.output).toEqual({ ok: true });
    // message/send + two tasks/get polls.
    expect(calls[1]?.init.body).toContain('tasks/get');
    expect(calls).toHaveLength(3);
  });

  it('carries the adapter credential and never a platform token', async () => {
    const { fetchImpl, calls } = jsonRpcFetch([task('completed')]);
    const client = new A2AClient({
      endpoint: 'http://remote/a2a',
      credential: 'own-cred',
      fetchImpl,
    });
    await client.send(SEND);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer own-cred');
  });

  it('times out if the remote never reaches a terminal state', async () => {
    const { fetchImpl } = jsonRpcFetch([task('working')]);
    const client = new A2AClient({
      endpoint: 'http://remote/a2a',
      credential: 'cred',
      fetchImpl,
      timeoutMs: 5,
      pollIntervalMs: 1,
      sleep: noSleep,
    });
    await expect(client.send(SEND)).rejects.toBeInstanceOf(A2ATimeoutError);
  });

  it('maps a non-terminal task with no id to a transport error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ jsonrpc: '2.0', id: '1', result: { status: { state: 'working' } } }),
      } as unknown as Response)) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toBeInstanceOf(A2ATransportError);
  });

  it('maps an http error to a transport error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ ok: false, status: 502 } as Response)) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toThrow(/http 502/);
  });

  it('maps a JSON-RPC error body to a transport error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'boom' } }),
      } as unknown as Response)) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toThrow(/boom/);
  });

  it('maps an unreachable remote to a transport error', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toBeInstanceOf(A2ATransportError);
  });

  it('maps an aborted (hung) fetch to a timeout error, not a transport error', async () => {
    // A remote that accepts the connection then never answers: the per-request
    // AbortSignal fires a TimeoutError. That is a deadline breach — the adapter
    // must surface A2ATimeoutError so the step is retried, not a transport fault.
    const fetchImpl = (() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toBeInstanceOf(A2ATimeoutError);
  });

  it('falls back to the status message data part and text', async () => {
    const { fetchImpl } = jsonRpcFetch([
      task('input-required', {
        status: {
          state: 'input-required',
          message: {
            parts: [
              { kind: 'text', data: 'which region?' },
              { kind: 'data', data: { needed: 'region' } },
            ],
          },
        },
      }),
    ]);
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    const view = await client.send(SEND);
    expect(view.state).toBe('input-required');
    expect(view.output).toEqual({ needed: 'region' });
    expect(view.message).toBe('which region?');
  });

  it('maps a non-json remote response to a transport error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response)) as unknown as typeof fetch;
    const client = new A2AClient({ endpoint: 'http://remote/a2a', credential: 'cred', fetchImpl });
    await expect(client.send(SEND)).rejects.toBeInstanceOf(A2ATransportError);
  });
});
