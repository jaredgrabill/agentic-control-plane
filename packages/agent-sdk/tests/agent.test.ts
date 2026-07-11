import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import YAML from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProtocolValidationError, type StepResult } from '@acp/protocol';
import { Agent, CapabilityError, ErrorClass, FakeModel } from '../src/index.js';
import { MANIFEST, goodOutput, stepRequest } from './fixtures.js';

let agent: Agent;
beforeEach(() => {
  agent = new Agent({ manifest: MANIFEST, model: new FakeModel() });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('registration', () => {
  it('rejects undeclared capabilities', () => {
    expect(() => {
      agent.capability('test.undeclared', () => Promise.resolve(goodOutput()));
    }).toThrow('not declared in the manifest');
  });

  it('rejects duplicate handlers', () => {
    const handler = (): Promise<Record<string, unknown>> => Promise.resolve(goodOutput());
    agent.capability('test.echo', handler);
    expect(() => {
      agent.capability('test.echo', handler);
    }).toThrow('already has a handler');
  });

  it('assertComplete names the missing handlers', () => {
    expect(() => {
      agent.assertComplete();
    }).toThrow('test.echo');
  });

  it('manifest validation fails loudly', () => {
    const { owner: _owner, ...bad } = MANIFEST;
    const dir = mkdtempSync(join(tmpdir(), 'acp-sdk-'));
    try {
      const path = join(dir, 'manifest.yaml');
      writeFileSync(path, YAML.stringify(bad), 'utf-8');
      expect(() => Agent.fromManifest(path)).toThrow(ProtocolValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execute', () => {
  it('happy path returns a completed StepResult', async () => {
    agent.capability('test.echo', (ctx, input) => {
      expect(ctx.tenant).toBe('acme');
      expect(ctx.capability).toBe('test.echo');
      return Promise.resolve(goodOutput(`echo: ${String(input.text)}`));
    });

    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('completed');
    expect((result.output as Record<string, unknown>).text).toBe('echo: hello');
    expect(result.kind).toBe('step_result');
    expect(result.usage).toEqual({ llm_calls: 0, input_tokens: 0, output_tokens: 0 });
  });

  it('malformed StepRequests are non-retryable', async () => {
    const err = await rejection(agent.execute({ kind: 'step_request' }));
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect((err as ApplicationFailure).type).toBe('Permanent');
    expect((err as ApplicationFailure).message).toContain('malformed StepRequest');
  });

  it('a missing handler fails typed', async () => {
    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
    expect(result.error?.message).toContain('no handler');
    expect(result.usage).toBeUndefined();
  });

  it('output schema violations get one repair retry, then succeed', async () => {
    let calls = 0;
    agent.capability('test.echo', () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? { wrong: 'shape' } : goodOutput());
    });

    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('completed');
    expect(calls).toBe(2);
  });

  it('output schema failure after the repair retry is typed permanent', async () => {
    agent.capability('test.echo', () => Promise.resolve({ wrong: 'shape' }));

    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
    expect(result.error?.message).toContain('output_schema');
  });

  it('needs_input is a definitive step outcome, not a thrown failure', async () => {
    agent.capability('test.echo', () =>
      Promise.reject(new CapabilityError(ErrorClass.NeedsInput, 'which policy do you mean?')),
    );

    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('needs_input');
    expect(result.usage).toEqual({ llm_calls: 0, input_tokens: 0, output_tokens: 0 });
  });

  it('retryable errors surface as retryable activity failures', async () => {
    agent.capability('test.echo', () =>
      Promise.reject(new CapabilityError(ErrorClass.Retryable, 'provider 429')),
    );

    const err = await rejection(agent.execute(stepRequest()));
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(false);
    expect((err as ApplicationFailure).type).toBe('Retryable');
  });

  it('non-CapabilityError exceptions propagate untouched', async () => {
    agent.capability('test.echo', () => Promise.reject(new RangeError('bug in the handler')));

    const err = await rejection(agent.execute(stepRequest()));
    expect(err).toBeInstanceOf(RangeError);
  });

  it('usage counts model calls', async () => {
    const counted = new Agent({ manifest: MANIFEST, model: new FakeModel(['one', 'two']) });
    counted.capability('test.echo', async (ctx) => {
      await ctx.model.complete('first');
      await ctx.model.complete('second');
      return goodOutput();
    });

    const result = await counted.execute(stepRequest());
    expect(result.usage?.llm_calls).toBe(2);
    expect(result.usage?.output_tokens).toBeGreaterThan(0);
  });

  it('retrieval requires a configured retriever', async () => {
    const captured: Record<string, string> = {};
    agent.capability('test.echo', async (ctx) => {
      try {
        await ctx.retrieve('q');
      } catch (err) {
        captured.error = (err as Error).message;
      }
      return goodOutput();
    });

    await agent.execute(stepRequest());
    expect(captured.error).toContain('no retriever configured');
  });

  it('retrieval requires the delegated token', async () => {
    const captured: Record<string, string> = {};
    const withRetriever = new Agent({
      manifest: MANIFEST,
      retriever: { search: () => Promise.resolve([]) },
    });
    withRetriever.capability('test.echo', async (ctx) => {
      try {
        await ctx.retrieve('q');
      } catch (err) {
        captured.error = (err as Error).message;
      }
      return goodOutput();
    });

    await withRetriever.execute(stepRequest());
    expect(captured.error).toContain('no delegated token');
  });

  it('the delegated token and step ids reach the retriever', async () => {
    const seen: unknown[] = [];
    const withRetriever = new Agent({
      manifest: MANIFEST,
      retriever: {
        search: (token, query, options) => {
          seen.push([token, query, options]);
          return Promise.resolve([{ content: 'passage' }]);
        },
      },
    });
    withRetriever.capability('test.echo', async (ctx) => {
      const results = await ctx.retrieve('change freeze', { k: 4 });
      expect(results).toHaveLength(1);
      return goodOutput();
    });

    const request = stepRequest({ delegated_token: 'delegated.jwt' });
    const result: StepResult = await withRetriever.execute(request);
    expect(result.status).toBe('completed');
    expect(seen).toEqual([
      [
        'delegated.jwt',
        'change freeze',
        { k: 4, taskId: request.task_id, stepId: request.step_id },
      ],
    ]);
  });

  it('taskQueue follows the orchestrator dispatch convention', () => {
    expect(agent.agentId).toBe('test-agent');
    expect(agent.taskQueue).toBe('agent-test-agent');
  });
});
