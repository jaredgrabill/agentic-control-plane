import { describe, expect, it } from 'vitest';
import type { CompletionPrompt } from '@acp/llm-client';
import { parseModelClasses } from '../src/classes.js';
import { validatePrompt, type ValidatedPrompt } from '../src/prompt.js';
import {
  AnthropicProvider,
  DevProvider,
  DEV_ECHO_MODEL,
  DEV_FAIL_429_MODEL,
  DEV_FAIL_500_MODEL,
  ProviderFault,
  RpmLimitedAdapter,
  buildProviders,
} from '../src/providers/index.js';
import type { ProviderRequest } from '../src/providers/index.js';

function promptOf(prompt: CompletionPrompt): ValidatedPrompt {
  const validated = validatePrompt(prompt);
  if (!validated.ok) throw new Error(validated.violations.join('; '));
  return validated.prompt;
}

function requestOf(prompt: CompletionPrompt): ProviderRequest {
  return {
    prompt: promptOf(prompt),
    maxTokens: 1024,
    temperature: 0,
    signal: new AbortController().signal,
  };
}

async function faultOf(promise: Promise<unknown>): Promise<ProviderFault> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderFault);
  return err as ProviderFault;
}

describe('DevProvider dev-echo@1', () => {
  it('is deterministic: identical prompts produce identical completions', async () => {
    const request = requestOf({
      static: [{ role: 'system', text: 'You are the knowledge agent.' }],
      variable: [{ role: 'user', text: 'What is the change freeze policy?' }],
    });
    const first = await new DevProvider().complete(DEV_ECHO_MODEL, request);
    const second = await new DevProvider().complete(DEV_ECHO_MODEL, request);
    expect(first.text).toBe(second.text);
    expect(first.text).toMatch(/^dev-llm@1 sha256:[0-9a-f]{12} What is the change freeze policy\?/);
    expect(first.usage).toEqual(second.usage);
  });

  it('returns the [[dev-llm]] directive payload verbatim — outputs scripted through data', async () => {
    const result = await new DevProvider().complete(
      DEV_ECHO_MODEL,
      requestOf({
        static: [],
        variable: [{ role: 'user', text: 'context first\n[[dev-llm]] {"answer": 42}\ntrailing' }],
      }),
    );
    expect(result.text).toBe('{"answer": 42}');
  });

  it('truncates the default echo to 160 chars of variable text', async () => {
    const long = 'x'.repeat(500);
    const result = await new DevProvider().complete(
      DEV_ECHO_MODEL,
      requestOf({ static: [], variable: [{ role: 'user', text: long }] }),
    );
    const preview = result.text.split(' ').slice(2).join(' ');
    expect(preview).toHaveLength(160);
  });

  it('simulates cache accounting: first prefix sighting creates, repeats read', async () => {
    const provider = new DevProvider();
    const prompt: CompletionPrompt = {
      static: [{ role: 'system', text: 'a'.repeat(400) }],
      variable: [{ role: 'user', text: 'q1' }],
    };
    const first = await provider.complete(DEV_ECHO_MODEL, requestOf(prompt));
    expect(first.usage.cache_creation_input_tokens).toBe(100);
    expect(first.usage.cache_read_input_tokens).toBe(0);

    const second = await provider.complete(DEV_ECHO_MODEL, {
      ...requestOf({ ...prompt, variable: [{ role: 'user', text: 'q2 different' }] }),
    });
    expect(second.usage.cache_creation_input_tokens).toBe(0);
    expect(second.usage.cache_read_input_tokens).toBe(100);
    expect(second.usage.input_tokens).toBe(Math.ceil('q2 different'.length / 4));

    // A different prefix is a fresh creation, not a read.
    const third = await provider.complete(
      DEV_ECHO_MODEL,
      requestOf({
        static: [{ role: 'system', text: 'b'.repeat(400) }],
        variable: [{ role: 'user', text: 'q3' }],
      }),
    );
    expect(third.usage.cache_creation_input_tokens).toBe(100);
  });

  it('bills no cache tokens when there is no static prefix', async () => {
    const result = await new DevProvider().complete(
      DEV_ECHO_MODEL,
      requestOf({ static: [], variable: [{ role: 'user', text: 'hi' }] }),
    );
    expect(result.usage.cache_creation_input_tokens).toBe(0);
    expect(result.usage.cache_read_input_tokens).toBe(0);
  });
});

describe('DevProvider scripted failures', () => {
  const request = requestOf({ static: [], variable: [{ role: 'user', text: 'hi' }] });

  it('dev-fail-429@1 always rate limits with retry_after 1s', async () => {
    const fault = await faultOf(new DevProvider().complete(DEV_FAIL_429_MODEL, request));
    expect(fault.kind).toBe('rate_limited');
    expect(fault.retryAfterS).toBe(1);
  });

  it('dev-fail-500@1 always faults server-side', async () => {
    const fault = await faultOf(new DevProvider().complete(DEV_FAIL_500_MODEL, request));
    expect(fault.kind).toBe('server');
  });

  it('an unknown dev model is an invalid_input fault', async () => {
    const fault = await faultOf(new DevProvider().complete('dev-mystery@9', request));
    expect(fault.kind).toBe('invalid_input');
  });
});

describe('buildProviders', () => {
  const config = (providers: Record<string, unknown>) =>
    parseModelClasses(
      JSON.stringify({
        kind: 'acp-model-classes/v1',
        version: '2026.07',
        providers,
        classes: {
          'default-tier': {
            bindings: [{ provider: Object.keys(providers)[0], model: 'm' }],
          },
        },
      }),
      'test.json',
    );

  it('builds a dev provider and an anthropic provider with a resolved key', () => {
    const providers = buildProviders(
      config({
        dev: { type: 'dev' },
        anthropic: { type: 'anthropic', api_key_env: 'TEST_ANTHROPIC_KEY' },
      }),
      { TEST_ANTHROPIC_KEY: 'sk-test' },
    );
    expect(providers.get('dev')).toBeInstanceOf(DevProvider);
    expect(providers.get('anthropic')).toBeInstanceOf(AnthropicProvider);
  });

  it('refuses to boot when the api key env is unset', () => {
    expect(() =>
      buildProviders(
        config({ anthropic: { type: 'anthropic', api_key_env: 'TEST_MISSING_KEY' } }),
        {},
      ),
    ).toThrow(/TEST_MISSING_KEY is not set/);
  });

  it('refuses to construct the dev provider under NODE_ENV=production', () => {
    expect(() =>
      buildProviders(config({ dev: { type: 'dev' } }), { NODE_ENV: 'production' }),
    ).toThrow(/dev provider must not be constructed under NODE_ENV=production/);
  });

  it('allows the dev provider in production only with ACP_ALLOW_DEV_PROVIDER set', () => {
    const providers = buildProviders(config({ dev: { type: 'dev' } }), {
      NODE_ENV: 'production',
      ACP_ALLOW_DEV_PROVIDER: '1',
    });
    expect(providers.get('dev')).toBeInstanceOf(DevProvider);
  });

  it('builds the dev provider outside production without any override', () => {
    const providers = buildProviders(config({ dev: { type: 'dev' } }), {
      NODE_ENV: 'development',
    });
    expect(providers.get('dev')).toBeInstanceOf(DevProvider);
  });

  it('wraps the adapter in an rpm bucket only when the config names one', () => {
    const providers = buildProviders(
      config({
        anthropic: { type: 'anthropic', api_key_env: 'TEST_ANTHROPIC_KEY', rpm: 2 },
      }),
      { TEST_ANTHROPIC_KEY: 'sk-test' },
    );
    expect(providers.get('anthropic')).toBeInstanceOf(RpmLimitedAdapter);
  });
});

describe('RpmLimitedAdapter', () => {
  const request = requestOf({ static: [], variable: [{ role: 'user', text: 'hi' }] });

  it('passes calls through under the cap and rate-limits at it, refilling over time', async () => {
    let clock = 0;
    const inner = { complete: () => new DevProvider().complete(DEV_ECHO_MODEL, request) };
    const limited = new RpmLimitedAdapter('anthropic', inner, 60, () => clock);

    for (let i = 0; i < 60; i++) {
      await limited.complete(DEV_ECHO_MODEL, request);
    }
    const fault = await faultOf(limited.complete(DEV_ECHO_MODEL, request));
    expect(fault.kind).toBe('rate_limited');
    expect(fault.message).toContain('local 60 rpm cap');
    expect(fault.retryAfterS).toBeGreaterThanOrEqual(1);

    clock += 1000; // one second refills one token at 60 rpm
    await expect(limited.complete(DEV_ECHO_MODEL, request)).resolves.toBeDefined();
  });
});
