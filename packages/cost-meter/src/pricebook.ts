/**
 * Node-side price book loader. Reads a versioned `acp-price-book/v1` file,
 * validates it locally with Ajv (this is platform config, NOT a wire
 * contract — no protocol schema, no Python binding, no parity surface), and
 * converts every USD/MTok rate to an integer micro-USD/MTok rate via
 * `Math.round(x * 1e6)`. The float→integer conversion happens here, on the
 * activity side, so the workflow isolate only ever sees integers.
 */

import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { ModelRateMicros, ResolvedPriceBook } from './pricing.js';

const rateSchema = {
  type: 'object',
  required: [
    'input_usd_per_mtok',
    'output_usd_per_mtok',
    'cache_read_usd_per_mtok',
    'cache_write_usd_per_mtok',
  ],
  additionalProperties: false,
  properties: {
    input_usd_per_mtok: { type: 'number', minimum: 0 },
    output_usd_per_mtok: { type: 'number', minimum: 0 },
    cache_read_usd_per_mtok: { type: 'number', minimum: 0 },
    cache_write_usd_per_mtok: { type: 'number', minimum: 0 },
  },
} as const;

const priceBookSchema = {
  type: 'object',
  required: ['kind', 'version', 'currency', 'fallback', 'models'],
  additionalProperties: false,
  properties: {
    kind: { const: 'acp-price-book/v1' },
    version: { type: 'string', minLength: 1 },
    currency: { const: 'USD' },
    fallback: rateSchema,
    models: {
      type: 'object',
      additionalProperties: rateSchema,
    },
  },
} as const;

interface UsdRate {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_read_usd_per_mtok: number;
  cache_write_usd_per_mtok: number;
}

interface PriceBookFile {
  kind: 'acp-price-book/v1';
  version: string;
  currency: 'USD';
  fallback: UsdRate;
  models: Record<string, UsdRate>;
}

const ajv = new Ajv({ allErrors: true });
const validatePriceBook = ajv.compile<PriceBookFile>(priceBookSchema);

/** USD/MTok → integer micro-USD/MTok. $3/MTok → 3_000_000 micros/MTok. */
function toRateMicros(rate: UsdRate): ModelRateMicros {
  return {
    inputMicrosPerMTok: Math.round(rate.input_usd_per_mtok * 1_000_000),
    outputMicrosPerMTok: Math.round(rate.output_usd_per_mtok * 1_000_000),
    cacheReadMicrosPerMTok: Math.round(rate.cache_read_usd_per_mtok * 1_000_000),
    cacheWriteMicrosPerMTok: Math.round(rate.cache_write_usd_per_mtok * 1_000_000),
  };
}

/**
 * Loads, validates, and resolves a price book to integer micro-USD rates.
 * Throws on a missing file, malformed JSON, or a document that fails
 * validation (unknown kind, missing/negative rate, extra property, no
 * fallback) — an unpriceable book is never silently trusted.
 */
export function loadResolvedPriceBook(options: { path: string }): ResolvedPriceBook {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(options.path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `price book at ${options.path} could not be read or parsed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!validatePriceBook(raw)) {
    const detail = (validatePriceBook.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`price book at ${options.path} is invalid: ${detail}`);
  }
  const models: Record<string, ModelRateMicros> = {};
  for (const [id, rate] of Object.entries(raw.models)) {
    models[id] = toRateMicros(rate);
  }
  return {
    version: raw.version,
    models,
    fallback: toRateMicros(raw.fallback),
  };
}
