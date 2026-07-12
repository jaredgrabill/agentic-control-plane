import { describe, expect, it } from 'vitest';
import { parseModelClasses } from '../src/classes.js';

const valid = {
  kind: 'acp-model-classes/v1',
  version: '2026.07',
  providers: {
    dev: { type: 'dev' },
    anthropic: { type: 'anthropic', api_key_env: 'ACP_ANTHROPIC_API_KEY' },
  },
  classes: {
    'default-tier': { bindings: [{ provider: 'dev', model: 'dev-echo@1' }] },
    'reasoning-tier': {
      bindings: [
        { provider: 'anthropic', model: 'claude-sonnet-4-5', max_attempts: 3, timeout_ms: 45000 },
        { provider: 'dev', model: 'dev-echo@1', max_attempts: 1 },
      ],
    },
  },
};

const parse = (mutate: (doc: Record<string, unknown>) => void) => {
  const doc = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  mutate(doc);
  return () => parseModelClasses(JSON.stringify(doc), 'test.json');
};

describe('parseModelClasses', () => {
  it('parses a valid config with defaults applied', () => {
    const config = parseModelClasses(JSON.stringify(valid), 'test.json');
    expect(config.version).toBe('2026.07');
    expect([...config.providers.keys()]).toEqual(['dev', 'anthropic']);
    const anthropic = config.providers.get('anthropic');
    expect(anthropic).toEqual({
      type: 'anthropic',
      api_key_env: 'ACP_ANTHROPIC_API_KEY',
      base_url: 'https://api.anthropic.com',
      rpm: undefined,
    });
    const defaultTier = config.classes.get('default-tier');
    expect(defaultTier?.bindings).toEqual([
      { provider: 'dev', model: 'dev-echo@1', max_attempts: 2, timeout_ms: 30000 },
    ]);
    const reasoning = config.classes.get('reasoning-tier');
    expect(reasoning?.bindings[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      max_attempts: 3,
      timeout_ms: 45000,
    });
  });

  it('accepts the reserved per-binding batch object without interpreting it', () => {
    expect(
      parse((doc) => {
        (doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
          'default-tier'
        ]!.bindings[0]!.batch = { enabled: false };
      }),
    ).not.toThrow();
  });

  it('rejects a wrong kind and a missing version', () => {
    expect(parse((doc) => (doc.kind = 'acp-model-classes/v2'))).toThrow(/kind must be/);
    expect(parse((doc) => delete doc.version)).toThrow(/version must be a non-empty string/);
  });

  it('rejects unknown keys at every level', () => {
    expect(parse((doc) => (doc.tolerence = 1))).toThrow(/unknown key "tolerence"/);
    expect(
      parse((doc) => ((doc.providers as Record<string, Record<string, unknown>>).dev!.rpm = 10)),
    ).toThrow(/provider dev: unknown key "rpm"/);
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, Record<string, unknown>>)['default-tier']!.fallback =
            true),
      ),
    ).toThrow(/class default-tier: unknown key "fallback"/);
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
            'default-tier'
          ]!.bindings[0]!.retries = 5),
      ),
    ).toThrow(/bindings\[0\]: unknown key "retries"/);
  });

  it('rejects empty bindings and unknown provider references', () => {
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, Record<string, unknown>>)['default-tier']!.bindings = []),
      ),
    ).toThrow(/bindings must be a non-empty array/);
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
            'default-tier'
          ]!.bindings[0]!.provider = 'openai'),
      ),
    ).toThrow(/unknown provider "openai"/);
  });

  it('rejects malformed provider specs', () => {
    expect(
      parse((doc) => ((doc.providers as Record<string, unknown>).broken = { type: 'mystery' })),
    ).toThrow(/provider broken: unknown type "mystery"/);
    expect(
      parse(
        (doc) => ((doc.providers as Record<string, unknown>).anthropic = { type: 'anthropic' }),
      ),
    ).toThrow(/api_key_env is required/);
    expect(
      parse(
        (doc) => ((doc.providers as Record<string, Record<string, unknown>>).anthropic!.rpm = -1),
      ),
    ).toThrow(/rpm must be a positive number/);
  });

  it('rejects malformed binding knobs', () => {
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
            'default-tier'
          ]!.bindings[0]!.max_attempts = 0),
      ),
    ).toThrow(/max_attempts must be a positive integer/);
    expect(
      parse(
        (doc) =>
          ((doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
            'default-tier'
          ]!.bindings[0]!.timeout_ms = -5),
      ),
    ).toThrow(/timeout_ms must be positive/);
    expect(
      parse(
        (doc) =>
          delete (doc.classes as Record<string, { bindings: Record<string, unknown>[] }>)[
            'default-tier'
          ]!.bindings[0]!.model,
      ),
    ).toThrow(/model is required/);
  });

  it('rejects empty providers, empty classes, and non-JSON', () => {
    expect(parse((doc) => (doc.providers = {}))).toThrow(/providers must map at least one/);
    expect(parse((doc) => (doc.classes = {}))).toThrow(/classes must map at least one/);
    expect(() => parseModelClasses('not json', 'test.json')).toThrow(/not valid JSON/);
    expect(() => parseModelClasses('[]', 'test.json')).toThrow(/expected a JSON object/);
  });
});
