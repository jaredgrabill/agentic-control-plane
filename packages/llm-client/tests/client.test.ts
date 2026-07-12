import { describe, expect, it } from 'vitest';
import { GatewayClient, LlmGatewayError } from '../src/client.js';
import type { CompletionRequest, CompletionResponse } from '../src/types.js';

const request: CompletionRequest = {
  model_class: 'default-tier',
  prompt: { static: [], variable: [{ role: 'user', text: 'ping' }] },
};

const response: CompletionResponse = {
  text: 'pong',
  model_class: 'default-tier',
  model: 'dev-echo@1',
  provider: 'dev',
  model_classes_version: '2026.07',
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 1 }],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  recorded?: { url?: string; init?: RequestInit | undefined },
): GatewayClient {
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (recorded !== undefined) {
      recorded.url = url;
      recorded.init = init;
    }
    return Promise.resolve(handler(url, init));
  };
  return new GatewayClient({ url: 'http://gateway.test', fetchImpl });
}

async function errorOf(promise: Promise<unknown>): Promise<LlmGatewayError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmGatewayError);
  return err as LlmGatewayError;
}

describe('GatewayClient.complete', () => {
  it('POSTs the request with bearer + correlation headers and returns the validated body', async () => {
    const recorded: { url?: string; init?: RequestInit } = {};
    const client = clientWith(() => jsonResponse(200, response), recorded);
    const result = await client.complete(request, {
      token: 'tkn',
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(result).toEqual(response);
    expect(recorded.url).toBe('http://gateway.test/v1/complete');
    const headers = recorded.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tkn');
    expect(headers['x-acp-task-id']).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');
    expect(headers['x-acp-step-id']).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44');
    expect(JSON.parse(recorded.init?.body as string)).toEqual(request);
  });

  it('omits correlation headers when no ids are given', async () => {
    const recorded: { url?: string; init?: RequestInit } = {};
    await clientWith(() => jsonResponse(200, response), recorded).complete(request, {
      token: 'tkn',
    });
    const headers = recorded.init?.headers as Record<string, string>;
    expect('x-acp-task-id' in headers).toBe(false);
    expect('x-acp-step-id' in headers).toBe(false);
  });

  it('maps a typed gateway error body onto LlmGatewayError verbatim', async () => {
    const client = clientWith(() =>
      jsonResponse(429, {
        error: {
          class: 'rate_limited',
          message: 'all bindings 429',
          status: 429,
          retry_after_s: 2,
        },
      }),
    );
    const err = await errorOf(client.complete(request, { token: 'tkn' }));
    expect(err.errorClass).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryAfterS).toBe(2);
    expect(err.message).toBe('all bindings 429');
  });

  it('derives the class from the status when a proxy answers without a typed body', async () => {
    for (const [status, cls] of [
      [400, 'invalid_input'],
      [401, 'unauthenticated'],
      [403, 'model_not_allowed'],
      [429, 'rate_limited'],
      [503, 'unavailable'],
    ] as const) {
      const client = clientWith(() => new Response('gateway timeout', { status }));
      const err = await errorOf(client.complete(request, { token: 'tkn' }));
      expect(err.errorClass).toBe(cls);
      expect(err.status).toBe(status);
      expect(err.message).toBe(`llm gateway request failed (${status})`);
    }
  });

  it('refuses a malformed 200 body instead of partially trusting it', async () => {
    const client = clientWith(() => jsonResponse(200, { text: 'no usage block' }));
    const err = await errorOf(client.complete(request, { token: 'tkn' }));
    expect(err.errorClass).toBe('unavailable');
    expect(err.status).toBe(502);
    expect(err.message).toContain('malformed completion response');
  });

  it('wraps network failures as unavailable 503', async () => {
    const client = new GatewayClient({
      url: 'http://gateway.test',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const err = await errorOf(client.complete(request, { token: 'tkn' }));
    expect(err.errorClass).toBe('unavailable');
    expect(err.status).toBe(503);
    expect(err.message).toBe('llm gateway unreachable: ECONNREFUSED');
  });
});

describe('GatewayClient.modelClasses', () => {
  it('returns the class map', async () => {
    const recorded: { url?: string; init?: RequestInit } = {};
    const client = clientWith(
      () =>
        jsonResponse(200, {
          version: '2026.07',
          classes: { 'default-tier': { models: ['dev/dev-echo@1'] } },
        }),
      recorded,
    );
    const classes = await client.modelClasses({ token: 'tkn' });
    expect(classes.version).toBe('2026.07');
    expect(classes.classes['default-tier']?.models).toEqual(['dev/dev-echo@1']);
    expect(recorded.url).toBe('http://gateway.test/v1/model-classes');
    expect((recorded.init?.headers as Record<string, string>).authorization).toBe('Bearer tkn');
  });

  it('maps refusals and network failures onto LlmGatewayError', async () => {
    const denied = await errorOf(
      clientWith(() => new Response('nope', { status: 401 })).modelClasses({ token: 'tkn' }),
    );
    expect(denied.errorClass).toBe('unauthenticated');
    expect(denied.message).toBe('llm gateway refused /v1/model-classes (401)');

    const down = await errorOf(
      new GatewayClient({
        url: 'http://gateway.test',
        fetchImpl: () => Promise.reject(new Error('boom')),
      }).modelClasses({ token: 'tkn' }),
    );
    expect(down.errorClass).toBe('unavailable');
  });
});
