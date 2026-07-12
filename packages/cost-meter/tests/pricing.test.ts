import { describe, expect, it } from 'vitest';
import { priceUsageMicros, type ResolvedPriceBook } from '../src/pricing.js';

// A test book in integer micro-USD/MTok (what the node loader would resolve to).
const book: ResolvedPriceBook = {
  version: 'test',
  models: {
    'known@1': {
      inputMicrosPerMTok: 3_000_000, // $3/MTok
      outputMicrosPerMTok: 15_000_000, // $15/MTok
      cacheReadMicrosPerMTok: 300_000, // $0.30/MTok
      cacheWriteMicrosPerMTok: 3_750_000, // $3.75/MTok
    },
    'cheap@1': {
      inputMicrosPerMTok: 250_000, // $0.25/MTok
      outputMicrosPerMTok: 250_000,
      cacheReadMicrosPerMTok: 250_000,
      cacheWriteMicrosPerMTok: 250_000,
    },
  },
  fallback: {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cacheReadMicrosPerMTok: 500_000,
    cacheWriteMicrosPerMTok: 6_250_000,
  },
};

describe('priceUsageMicros', () => {
  it('undefined usage is free', () => {
    expect(priceUsageMicros(undefined, book)).toEqual({ micros: 0, fallbackUsed: false });
  });

  it('all-zero usage is free even when the model is unknown (no fallback consulted)', () => {
    expect(
      priceUsageMicros({ model: 'no-such-model', input_tokens: 0, output_tokens: 0 }, book),
    ).toEqual({ micros: 0, fallbackUsed: false });
  });

  it('absent-token usage with no model is free', () => {
    expect(priceUsageMicros({ llm_calls: 0 } as never, book)).toEqual({
      micros: 0,
      fallbackUsed: false,
    });
  });

  it('prices input + output at the known model rate (1000 in @ $3 + 2000 out @ $15 = 33,000 micros)', () => {
    expect(
      priceUsageMicros({ model: 'known@1', input_tokens: 1000, output_tokens: 2000 }, book),
    ).toEqual({ micros: 33_000, fallbackUsed: false });
  });

  it('rounds each component up: 1 token @ $0.25/MTok → 1 micro', () => {
    expect(priceUsageMicros({ model: 'cheap@1', input_tokens: 1 }, book)).toEqual({
      micros: 1,
      fallbackUsed: false,
    });
  });

  it('prices cache reads and writes at their own rates', () => {
    // 2000 read @ $0.30/MTok = 600 micros; 1000 write @ $3.75/MTok = 3750 micros.
    expect(
      priceUsageMicros(
        { model: 'known@1', cache_read_tokens: 2000, cache_write_tokens: 1000 },
        book,
      ),
    ).toEqual({ micros: 600 + 3750, fallbackUsed: false });
  });

  it('sums all four components', () => {
    // 1000 in (3000) + 2000 out (30000) + 2000 read (600) + 1000 write (3750)
    expect(
      priceUsageMicros(
        {
          model: 'known@1',
          input_tokens: 1000,
          output_tokens: 2000,
          cache_read_tokens: 2000,
          cache_write_tokens: 1000,
        },
        book,
      ),
    ).toEqual({ micros: 3000 + 30000 + 600 + 3750, fallbackUsed: false });
  });

  it('uses fallback rates and flags fallbackUsed for an unknown model with tokens', () => {
    // 1000 in @ $5/MTok = 5000 micros on the fallback.
    expect(priceUsageMicros({ model: 'mystery@9', input_tokens: 1000 }, book)).toEqual({
      micros: 5000,
      fallbackUsed: true,
    });
  });

  it('uses fallback rates when the model is absent entirely', () => {
    expect(priceUsageMicros({ input_tokens: 1000 }, book)).toEqual({
      micros: 5000,
      fallbackUsed: true,
    });
  });

  it('does not flag fallback for a known model', () => {
    expect(priceUsageMicros({ model: 'known@1', input_tokens: 1 }, book).fallbackUsed).toBe(false);
  });

  it('stays finite and non-negative on large token counts', () => {
    const result = priceUsageMicros(
      { model: 'known@1', input_tokens: 5_000_000, output_tokens: 5_000_000 },
      book,
    );
    expect(Number.isFinite(result.micros)).toBe(true);
    expect(result.micros).toBeGreaterThan(0);
    // 5e6 in @ $3/MTok = 15e6 micros; 5e6 out @ $15/MTok = 75e6 micros.
    expect(result.micros).toBe(15_000_000 + 75_000_000);
  });
});
