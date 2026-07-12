/**
 * The anthropic adapter against a mocked fetch — the ONLY way this
 * adapter is ever exercised outside production (dev/CI bind every class
 * to the dev provider).
 */

import { describe, expect, it } from 'vitest';
import type { CompletionPrompt } from '@acp/llm-client';
import { validatePrompt } from '../src/prompt.js';
import {
  AnthropicProvider,
  ANTHROPIC_VERSION,
  ProviderFault,
  buildRequestBody,
} from '../src/providers/index.js';
import type { ProviderRequest } from '../src/providers/index.js';

function requestOf(prompt: CompletionPrompt, signal?: AbortSignal): ProviderRequest {
  const validated = validatePrompt(prompt);
  if (!validated.ok) throw new Error(validated.violations.join('; '));
  return {
    prompt: validated.prompt,
    maxTokens: 256,
    temperature: 0.2,
    signal: signal ?? new AbortController().signal,
  };
}

interface Recorded {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

function providerWith(
  respond: () => Response | Promise<Response>,
  recorded?: Recorded,
): AnthropicProvider {
  const fetchImpl: typeof fetch = (input, init) => {
    if (recorded !== undefined) {
      recorded.url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      recorded.headers = init?.headers as Record<string, string>;
      recorded.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    }
    return Promise.resolve(respond());
  };
  return new AnthropicProvider({
    apiKey: 'sk-test',
    baseUrl: 'https://anthropic.test',
    fetchImpl,
  });
}

const okBody = {
  content: [{ type: 'text', text: 'answer text' }],
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_input_tokens: 1300,
    cache_creation_input_tokens: 0,
  },
};

async function faultOf(promise: Promise<unknown>): Promise<ProviderFault> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderFault);
  return err as ProviderFault;
}

describe('request building', () => {
  it('routes system statics to the system array, others to messages, in assembled order', () => {
    const body = buildRequestBody(
      'claude-sonnet-4-5',
      requestOf({
        static: [
          { role: 'system', text: 'rules' },
          { role: 'user', text: 'tool schemas' },
        ],
        variable: [
          { role: 'assistant', text: 'prior' },
          { role: 'user', text: 'question' },
        ],
      }),
    );
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toEqual([{ type: 'text', text: 'rules' }]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'tool schemas' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prior' }] },
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
    ]);
  });

  it('places cache_control on the LAST static block when the prefix is ≥1024 estimated tokens', () => {
    const big = 'a'.repeat(4096); // exactly 1024 estimated tokens
    const body = buildRequestBody(
      'claude-sonnet-4-5',
      requestOf({
        static: [
          { role: 'system', text: big },
          { role: 'system', text: 'closing rubric' },
        ],
        variable: [{ role: 'user', text: 'q' }],
      }),
    );
    const system = body.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('places the breakpoint in messages when the last static block is not system-role', () => {
    const big = 'a'.repeat(4096);
    const body = buildRequestBody(
      'claude-sonnet-4-5',
      requestOf({
        static: [
          { role: 'system', text: big },
          { role: 'user', text: 'tool schemas' },
        ],
        variable: [{ role: 'user', text: 'q' }],
      }),
    );
    const messages = body.messages as { content: { cache_control?: unknown }[] }[];
    expect(messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[1]!.content[0]!.cache_control).toBeUndefined();
  });

  it('omits cache_control below the 1024-token threshold', () => {
    const body = buildRequestBody(
      'claude-sonnet-4-5',
      requestOf({
        static: [{ role: 'system', text: 'a'.repeat(4092) }], // 1023 tokens
        variable: [{ role: 'user', text: 'q' }],
      }),
    );
    const system = body.system as { cache_control?: unknown }[];
    expect(system[0]!.cache_control).toBeUndefined();
  });

  it('demotes a variable system block to a user turn (no in-thread system role)', () => {
    const body = buildRequestBody(
      'claude-sonnet-4-5',
      requestOf({
        static: [],
        variable: [
          { role: 'system', text: 'late instruction' },
          { role: 'user', text: 'q' },
        ],
      }),
    );
    const messages = body.messages as { role: string }[];
    expect(messages[0]!.role).toBe('user');
    expect(body.system).toBeUndefined();
  });
});

describe('completion + usage mapping', () => {
  it('POSTs /v1/messages with api key + version headers and maps usage 1:1', async () => {
    const recorded: Recorded = {};
    const provider = providerWith(() => new Response(JSON.stringify(okBody)), recorded);
    const result = await provider.complete(
      'claude-sonnet-4-5',
      requestOf({ static: [], variable: [{ role: 'user', text: 'q' }] }),
    );
    expect(recorded.url).toBe('https://anthropic.test/v1/messages');
    expect(recorded.headers!['x-api-key']).toBe('sk-test');
    expect(recorded.headers!['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(result.text).toBe('answer text');
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 1300,
      cache_creation_input_tokens: 0,
    });
  });

  it('defaults absent usage counters to zero and concatenates text parts', async () => {
    const provider = providerWith(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'part one, ' },
              { type: 'tool_use', id: 'x' },
              { type: 'text', text: 'part two' },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        ),
    );
    const result = await provider.complete(
      'claude-sonnet-4-5',
      requestOf({ static: [], variable: [{ role: 'user', text: 'q' }] }),
    );
    expect(result.text).toBe('part one, part two');
    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(result.usage.cache_creation_input_tokens).toBe(0);
  });
});

describe('fault mapping', () => {
  const request = () => requestOf({ static: [], variable: [{ role: 'user', text: 'q' }] });
  const status = (code: number, headers?: Record<string, string>) =>
    providerWith(
      () =>
        new Response(JSON.stringify({ error: { message: `upstream said ${code}` } }), {
          status: code,
          ...(headers !== undefined ? { headers } : {}),
        }),
    );

  it('429 → rate_limited with the retry-after header (default 1s)', async () => {
    const withHeader = await faultOf(status(429, { 'retry-after': '7' }).complete('m', request()));
    expect(withHeader.kind).toBe('rate_limited');
    expect(withHeader.retryAfterS).toBe(7);

    const withoutHeader = await faultOf(status(429).complete('m', request()));
    expect(withoutHeader.retryAfterS).toBe(1);
  });

  it('529 (overloaded) and 500 → server; 401/403 → upstream_auth; 408 → timeout; 400 → invalid_input', async () => {
    expect((await faultOf(status(529).complete('m', request()))).kind).toBe('server');
    expect((await faultOf(status(500).complete('m', request()))).kind).toBe('server');
    expect((await faultOf(status(401).complete('m', request()))).kind).toBe('upstream_auth');
    expect((await faultOf(status(403).complete('m', request()))).kind).toBe('upstream_auth');
    expect((await faultOf(status(408).complete('m', request()))).kind).toBe('timeout');
    const invalid = await faultOf(status(400).complete('m', request()));
    expect(invalid.kind).toBe('invalid_input');
    expect(invalid.message).toBe('anthropic answered 400: upstream said 400');
  });

  it('network failures → network; an aborted signal → timeout', async () => {
    const down = new AnthropicProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://anthropic.test',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    const networkFault = await faultOf(down.complete('m', request()));
    expect(networkFault.kind).toBe('network');
    expect(networkFault.message).toBe('anthropic unreachable: ECONNRESET');

    const controller = new AbortController();
    controller.abort();
    const aborted = new AnthropicProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://anthropic.test',
      fetchImpl: () => Promise.reject(new Error('aborted')),
    });
    const timeoutFault = await faultOf(
      aborted.complete(
        'm',
        requestOf({ static: [], variable: [{ role: 'user', text: 'q' }] }, controller.signal),
      ),
    );
    expect(timeoutFault.kind).toBe('timeout');
  });
});
