import { describe, expect, it } from 'vitest';
import { completionRequest, completionResponse, llmErrorBody } from '../src/schema.js';
import type { CompletionRequest, CompletionResponse } from '../src/types.js';

const validRequest: CompletionRequest = {
  model_class: 'default-tier',
  prompt: {
    static: [{ role: 'system', text: 'You are the cloud estate agent.' }],
    variable: [{ role: 'user', text: 'What changed in prod this week?' }],
  },
  max_tokens: 512,
  temperature: 0,
  metadata: {
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    capability: 'cloud.inventory_query',
    purpose: 'agent',
  },
};

const validResponse: CompletionResponse = {
  text: 'dev-llm@1 sha256:abcdef123456 What changed in prod this week?',
  model_class: 'default-tier',
  model: 'dev-echo@1',
  provider: 'dev',
  model_classes_version: '2026.07',
  usage: {
    input_tokens: 12,
    output_tokens: 15,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 8,
  },
  attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 2 }],
};

describe('completionRequest schema', () => {
  it('accepts a full request and a minimal one', () => {
    expect(completionRequest.validate(validRequest)).toBe(true);
    expect(
      completionRequest.validate({
        model_class: 'cheap-tier',
        prompt: { static: [], variable: [{ role: 'user', text: 'hi' }] },
      }),
    ).toBe(true);
  });

  it('rejects an empty variable section — a prompt must carry input', () => {
    expect(
      completionRequest.validate({
        model_class: 'default-tier',
        prompt: { static: [{ role: 'system', text: 's' }], variable: [] },
      }),
    ).toBe(false);
  });

  it('rejects more than 4 static blocks (the stable-prefix cap)', () => {
    const block = { role: 'system', text: 's' };
    expect(
      completionRequest.validate({
        model_class: 'default-tier',
        prompt: { static: [block, block, block, block, block], variable: [block] },
      }),
    ).toBe(false);
  });

  it('rejects unknown roles, empty text, and unknown top-level keys', () => {
    expect(
      completionRequest.validate({
        model_class: 'default-tier',
        prompt: { static: [], variable: [{ role: 'tool', text: 'x' }] },
      }),
    ).toBe(false);
    expect(
      completionRequest.validate({
        model_class: 'default-tier',
        prompt: { static: [], variable: [{ role: 'user', text: '' }] },
      }),
    ).toBe(false);
    expect(completionRequest.validate({ ...validRequest, model: 'gpt-x' })).toBe(false);
  });

  it('rejects non-uuid correlation ids and unknown purposes in metadata', () => {
    expect(
      completionRequest.validate({
        ...validRequest,
        metadata: { task_id: 'not-a-uuid' },
      }),
    ).toBe(false);
    expect(
      completionRequest.validate({
        ...validRequest,
        metadata: { purpose: 'exfiltration' },
      }),
    ).toBe(false);
  });

  it('names the violated path in errors()', () => {
    const errors = completionRequest.errors({ model_class: '', prompt: null });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('/model_class'))).toBe(true);
    expect(completionRequest.errors(validRequest)).toEqual([]);
  });
});

describe('completionResponse schema', () => {
  it('accepts a valid response', () => {
    expect(completionResponse.validate(validResponse)).toBe(true);
  });

  it('rejects missing usage counters and empty attempts', () => {
    const { cache_read_input_tokens: _dropped, ...partialUsage } = validResponse.usage;
    expect(completionResponse.validate({ ...validResponse, usage: partialUsage })).toBe(false);
    expect(completionResponse.validate({ ...validResponse, attempts: [] })).toBe(false);
  });
});

describe('llmErrorBody schema', () => {
  it('round-trips every error class', () => {
    for (const cls of [
      'invalid_input',
      'unauthenticated',
      'model_not_allowed',
      'model_class_unknown',
      'rate_limited',
      'unavailable',
      'killswitch',
    ]) {
      expect(llmErrorBody.validate({ error: { class: cls, message: 'm', status: 400 } })).toBe(
        true,
      );
    }
    expect(
      llmErrorBody.validate({
        error: { class: 'rate_limited', message: 'm', status: 429, retry_after_s: 2 },
      }),
    ).toBe(true);
  });

  it('rejects unknown classes and missing status', () => {
    expect(llmErrorBody.validate({ error: { class: 'oops', message: 'm', status: 500 } })).toBe(
      false,
    );
    expect(llmErrorBody.validate({ error: { class: 'unavailable', message: 'm' } })).toBe(false);
  });
});
