/**
 * Ajv schemas for the gateway wire shapes. The gateway validates every
 * inbound CompletionRequest with these before anything else runs, and the
 * client validates every 200 body before handing it to a caller — a
 * malformed document on either side is refused, never partially trusted.
 */

import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { CompletionRequest, CompletionResponse, LlmErrorBody } from './types.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const promptBlock = {
  type: 'object',
  required: ['role', 'text'],
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['system', 'user', 'assistant'] },
    text: { type: 'string', minLength: 1 },
  },
} as const;

export const completionRequestSchema = {
  type: 'object',
  required: ['model_class', 'prompt'],
  additionalProperties: false,
  properties: {
    model_class: { type: 'string', minLength: 1 },
    prompt: {
      type: 'object',
      required: ['static', 'variable'],
      additionalProperties: false,
      properties: {
        static: { type: 'array', items: promptBlock, maxItems: 4 },
        variable: { type: 'array', items: promptBlock, minItems: 1 },
      },
    },
    max_tokens: { type: 'integer', minimum: 1 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    metadata: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', pattern: UUID_PATTERN },
        step_id: { type: 'string', pattern: UUID_PATTERN },
        capability: { type: 'string', minLength: 1 },
        purpose: { type: 'string', enum: ['agent', 'judge', 'planner', 'synthesis', 'probe'] },
      },
    },
  },
} as const;

export const completionResponseSchema = {
  type: 'object',
  required: [
    'text',
    'model_class',
    'model',
    'provider',
    'model_classes_version',
    'usage',
    'attempts',
  ],
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    model_class: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    model_classes_version: { type: 'string', minLength: 1 },
    usage: {
      type: 'object',
      required: [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ],
      additionalProperties: false,
      properties: {
        input_tokens: { type: 'integer', minimum: 0 },
        output_tokens: { type: 'integer', minimum: 0 },
        cache_read_input_tokens: { type: 'integer', minimum: 0 },
        cache_creation_input_tokens: { type: 'integer', minimum: 0 },
      },
    },
    attempts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['provider', 'model', 'outcome', 'duration_ms'],
        additionalProperties: false,
        properties: {
          provider: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          outcome: { type: 'string', minLength: 1 },
          duration_ms: { type: 'number', minimum: 0 },
        },
      },
    },
  },
} as const;

export const llmErrorBodySchema = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['class', 'message', 'status'],
      additionalProperties: false,
      properties: {
        class: {
          type: 'string',
          enum: [
            'invalid_input',
            'unauthenticated',
            'model_not_allowed',
            'model_class_unknown',
            'rate_limited',
            'unavailable',
            'killswitch',
          ],
        },
        message: { type: 'string' },
        status: { type: 'integer' },
        retry_after_s: { type: 'number', minimum: 0 },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });

function violationsOf(compiled: ValidateFunction, value: unknown): string[] {
  if (compiled(value)) return [];
  return (compiled.errors ?? []).map(
    (e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'invalid'}`,
  );
}

const validateRequestFn = ajv.compile<CompletionRequest>(completionRequestSchema);
const validateResponseFn = ajv.compile<CompletionResponse>(completionResponseSchema);
const validateErrorBodyFn = ajv.compile<LlmErrorBody>(llmErrorBodySchema);

export const completionRequest = {
  validate: (value: unknown): value is CompletionRequest => validateRequestFn(value),
  errors: (value: unknown): string[] => violationsOf(validateRequestFn, value),
};
export const completionResponse = {
  validate: (value: unknown): value is CompletionResponse => validateResponseFn(value),
  errors: (value: unknown): string[] => violationsOf(validateResponseFn, value),
};
export const llmErrorBody = {
  validate: (value: unknown): value is LlmErrorBody => validateErrorBodyFn(value),
  errors: (value: unknown): string[] => violationsOf(validateErrorBodyFn, value),
};
