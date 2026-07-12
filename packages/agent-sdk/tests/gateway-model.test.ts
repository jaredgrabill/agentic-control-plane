/**
 * GatewayModel against a scripted fetch: the prompt layout it emits, the
 * normative error mapping (429/5xx → Retryable, 403 → PolicyDenied, other
 * 4xx → Permanent), and the withCallContext() binding through
 * Agent.execute() — including proof the FakeModel path is untouched.
 */

import { describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResponse } from '@acp/llm-client';
import { Agent } from '../src/agent.js';
import { CapabilityError } from '../src/errors.js';
import { GatewayModel } from '../src/gateway-model.js';
import { FakeModel, isContextualModel } from '../src/model.js';
import { MANIFEST, goodOutput, stepRequest } from './fixtures.js';

const gatewayResponse = (text = 'gateway says hi'): CompletionResponse => ({
  text,
  model_class: 'default-tier',
  model: 'dev-echo@1',
  provider: 'dev',
  model_classes_version: '2026.07',
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 5,
  },
  attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 2 }],
});

interface Recorded {
  url?: string;
  headers?: Record<string, string>;
  body?: CompletionRequest;
}

function fetchReturning(status: number, body: unknown, recorded?: Recorded): typeof fetch {
  return (input, init) => {
    if (recorded !== undefined) {
      recorded.url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      recorded.headers = init?.headers as Record<string, string>;
      recorded.body = JSON.parse(init?.body as string) as CompletionRequest;
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
}

const CONTEXT = {
  delegatedToken: 'delegated-jwt',
  taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
  stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
  tenant: 'acme',
  capability: 'test.echo',
};

function boundModel(fetchImpl: typeof fetch, staticPrefix?: { role: 'system'; text: string }[]) {
  return new GatewayModel(
    {
      url: 'http://gateway.test',
      modelClass: 'default-tier',
      ...(staticPrefix !== undefined ? { staticPrefix } : {}),
      fetchImpl,
    },
    CONTEXT,
  );
}

async function errorOf(promise: Promise<unknown>): Promise<CapabilityError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CapabilityError);
  return err as CapabilityError;
}

describe('GatewayModel.complete', () => {
  it('sends the static prefix and the prompt as the variable tail, with identity + correlation', async () => {
    const recorded: Recorded = {};
    const model = boundModel(fetchReturning(200, gatewayResponse(), recorded), [
      { role: 'system', text: 'You are the test agent.' },
    ]);
    const response = await model.complete('what changed?', { maxTokens: 256 });

    expect(recorded.url).toBe('http://gateway.test/v1/complete');
    expect(recorded.headers!.authorization).toBe('Bearer delegated-jwt');
    expect(recorded.headers!['x-acp-task-id']).toBe(CONTEXT.taskId);
    expect(recorded.headers!['x-acp-step-id']).toBe(CONTEXT.stepId);
    expect(recorded.body).toEqual({
      model_class: 'default-tier',
      prompt: {
        static: [{ role: 'system', text: 'You are the test agent.' }],
        variable: [{ role: 'user', text: 'what changed?' }],
      },
      max_tokens: 256,
      metadata: {
        task_id: CONTEXT.taskId,
        step_id: CONTEXT.stepId,
        capability: 'test.echo',
        purpose: 'agent',
      },
    });

    expect(response.text).toBe('gateway says hi');
    // Cache reads/writes are real processed input — the budget counts them.
    expect(response.inputTokens).toBe(45);
    expect(response.outputTokens).toBe(4);
    expect(response.model).toBe('dev-echo@1');
  });

  it('defaults maxTokens to 1024 and the static prefix to []', async () => {
    const recorded: Recorded = {};
    await boundModel(fetchReturning(200, gatewayResponse(), recorded)).complete('q');
    expect(recorded.body!.max_tokens).toBe(1024);
    expect(recorded.body!.prompt.static).toEqual([]);
  });

  it('fails Permanent without a bound call context (no delegated token to ride)', async () => {
    const unbound = new GatewayModel({
      url: 'http://gateway.test',
      modelClass: 'default-tier',
      fetchImpl: fetchReturning(200, gatewayResponse()),
    });
    const err = await errorOf(unbound.complete('q'));
    expect(err.errorClass).toBe('permanent');
    expect(err.message).toContain('not bound to a call context');
  });

  it('maps 429 and 5xx to Retryable — Temporal owns the retry after gateway failover', async () => {
    const limited = await errorOf(
      boundModel(
        fetchReturning(429, {
          error: {
            class: 'rate_limited',
            message: 'every binding 429',
            status: 429,
            retry_after_s: 3,
          },
        }),
      ).complete('q'),
    );
    expect(limited.errorClass).toBe('retryable');
    expect(limited.message).toBe('every binding 429');
    expect(limited.details).toMatchObject({ status: 429, retry_after_s: 3 });

    const down = await errorOf(
      boundModel(
        fetchReturning(503, {
          error: { class: 'unavailable', message: 'all bindings failed', status: 503 },
        }),
      ).complete('q'),
    );
    expect(down.errorClass).toBe('retryable');
  });

  it('maps 403 to PolicyDenied and other 4xx to Permanent', async () => {
    const denied = await errorOf(
      boundModel(
        fetchReturning(403, {
          error: { class: 'model_not_allowed', message: 'not in models.allowed', status: 403 },
        }),
      ).complete('q'),
    );
    expect(denied.errorClass).toBe('policy_denied');
    expect(denied.message).toBe('not in models.allowed');

    const badClass = await errorOf(
      boundModel(
        fetchReturning(400, {
          error: { class: 'model_class_unknown', message: 'unknown class', status: 400 },
        }),
      ).complete('q'),
    );
    expect(badClass.errorClass).toBe('permanent');

    const unauthenticated = await errorOf(
      boundModel(
        fetchReturning(401, {
          error: { class: 'unauthenticated', message: 'token expired', status: 401 },
        }),
      ).complete('q'),
    );
    expect(unauthenticated.errorClass).toBe('permanent');
  });

  it('maps network failures to Retryable', async () => {
    const model = new GatewayModel(
      {
        url: 'http://gateway.test',
        modelClass: 'default-tier',
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      },
      CONTEXT,
    );
    const err = await errorOf(model.complete('q'));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('llm gateway unreachable: ECONNREFUSED');
  });
});

describe('Agent.execute binding', () => {
  it('binds a contextual model to the step context before the handler sees it', async () => {
    const recorded: Recorded = {};
    const agent = new Agent({
      manifest: MANIFEST,
      model: new GatewayModel({
        url: 'http://gateway.test',
        modelClass: 'default-tier',
        fetchImpl: fetchReturning(200, gatewayResponse('bound answer')),
      }),
    });
    agent.capability('test.echo', async (ctx) => {
      const completion = await ctx.model.complete('inner prompt');
      return goodOutput(completion.text);
    });
    // Rebuild with a recording fetch now that the handler is registered.
    agent.model = new GatewayModel({
      url: 'http://gateway.test',
      modelClass: 'default-tier',
      fetchImpl: fetchReturning(200, gatewayResponse('bound answer'), recorded),
    });

    const result = await agent.execute(stepRequest({ delegated_token: 'step-jwt' }));
    expect(result.status).toBe('completed');
    expect(recorded.headers!.authorization).toBe('Bearer step-jwt');
    expect(recorded.body!.metadata).toEqual({
      task_id: stepRequest().task_id,
      step_id: stepRequest().step_id,
      capability: 'test.echo',
      purpose: 'agent',
    });
    // Usage flowed through CountingModel from the gateway's counters.
    expect(result.usage).toEqual({ llm_calls: 1, input_tokens: 45, output_tokens: 4 });
  });

  it('isContextualModel: GatewayModel yes, FakeModel no — the unit-test seam is untouched', () => {
    expect(
      isContextualModel(
        new GatewayModel({ url: 'http://gateway.test', modelClass: 'default-tier' }),
      ),
    ).toBe(true);
    expect(isContextualModel(new FakeModel())).toBe(false);
  });

  it('an agent with no model still executes on the lazy FakeModel fallback', async () => {
    const agent = new Agent({ manifest: MANIFEST });
    expect(agent.model).toBeUndefined();
    agent.capability('test.echo', (ctx) => {
      // The fallback FakeModel with an empty script rejects on use — but a
      // handler that never calls the model works exactly as before.
      expect(isContextualModel(ctx.model)).toBe(false);
      return Promise.resolve(goodOutput());
    });
    const result = await agent.execute(stepRequest());
    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ llm_calls: 0, input_tokens: 0, output_tokens: 0 });
  });
});
