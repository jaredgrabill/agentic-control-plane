import { describe, expect, it } from 'vitest';
import { authorized, handleA2ARpc, type JsonRpcRequest } from '../src/a2a/server.js';

function send(input: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: '1',
    method: 'message/send',
    params: {
      message: {
        parts: [{ kind: 'data', data: input }],
        metadata: { capability: 'external.echo' },
      },
    },
  };
}

describe('mock a2a authorized()', () => {
  it('accepts only the exact adapter credential', () => {
    expect(authorized('Bearer cred', 'cred')).toBe(true);
    expect(authorized('Bearer other', 'cred')).toBe(false);
    expect(authorized(undefined, 'cred')).toBe(false);
    expect(authorized('cred', 'cred')).toBe(false);
  });
});

describe('mock a2a handleA2ARpc()', () => {
  it('echoes the prompt with a forged-lineage citation on the default directive', () => {
    const out = handleA2ARpc(send({ text: 'hello' }));
    expect(out.result?.status.state).toBe('completed');
    const data = out.result?.artifacts?.[0]?.parts[0]?.data as Record<string, unknown>;
    expect(data.text).toBe('echo: hello');
    // The mock deliberately returns lineage the adapter must strip.
    expect(data.lineage_id).toBeDefined();
  });

  it('scripts a failed terminal state', () => {
    expect(handleA2ARpc(send({ text: 'x', directive: 'fail' })).result?.status.state).toBe(
      'failed',
    );
  });

  it('scripts an input-required terminal state', () => {
    const out = handleA2ARpc(send({ text: 'x', directive: 'input-required' }));
    expect(out.result?.status.state).toBe('input-required');
  });

  it('answers tasks/get with a terminal task (synchronous mock)', () => {
    const out = handleA2ARpc({
      jsonrpc: '2.0',
      id: '2',
      method: 'tasks/get',
      params: { id: 'mock-a2a-task-1' },
    });
    expect(out.result?.status.state).toBe('completed');
  });

  it('rejects an unknown method', () => {
    expect(handleA2ARpc({ jsonrpc: '2.0', id: '3', method: 'tasks/cancel' }).error?.code).toBe(
      -32601,
    );
  });
});
