import { CapabilityError, ErrorClass } from '@acp/agent-sdk';
import { describe, expect, it } from 'vitest';
import { FakeToolClient, noRetriever, type ToolResponse } from '../src/index.js';

const RESPONSE: ToolResponse = {
  data: { hello: 'world' },
  provenance: [{ doc_id: 'd', version: '1', lineage_id: 'l' }],
};

describe('FakeToolClient', () => {
  it('records every call in order and routes by server.tool', async () => {
    const fake = new FakeToolClient({
      'cloud-estate.inventory_search': (args) => ({ ...RESPONSE, data: args }),
    });
    const response = await fake.call('cloud-estate', 'inventory_search', { env: 'prod' });
    expect(response.data).toEqual({ env: 'prod' });
    expect(fake.calls).toEqual([
      { server: 'cloud-estate', tool: 'inventory_search', args: { env: 'prod' } },
    ]);
    expect('options' in fake.calls[0]!).toBe(false);
  });

  it('records CallOptions verbatim when provided', async () => {
    const fake = new FakeToolClient({
      'cloud-estate.inventory_search': () => RESPONSE,
    });
    const options = { delegatedToken: 'tok-1', taskId: 'task-1', stepId: 'step-1' };
    await fake.call('cloud-estate', 'inventory_search', { env: 'prod' }, options);
    expect(fake.calls[0]!.options).toEqual(options);
    expect(fake.calls[0]!.options).toBe(options);
  });

  it('throws loudly on a missing handler', async () => {
    const fake = new FakeToolClient({});
    await expect(fake.call('cloud-estate', 'cost_report', {})).rejects.toThrow(
      'FakeToolClient has no handler for cloud-estate.cost_report',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('propagates scripted CapabilityErrors untouched', async () => {
    const fake = new FakeToolClient({
      'cloud-estate.cost_report': () => {
        throw new CapabilityError(ErrorClass.Retryable, 'rate limited', { retry_after_s: 2 });
      },
    });
    const err = await fake.call('cloud-estate', 'cost_report', {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).errorClass).toBe('retryable');
    expect((err as CapabilityError).details).toEqual({ retry_after_s: 2 });
  });
});

describe('noRetriever', () => {
  it('rejects every search with the agent named', async () => {
    await expect(noRetriever('cloud-agent').search('token', 'anything')).rejects.toThrow(
      'agent cloud-agent does not use the knowledge retriever',
    );
  });
});
