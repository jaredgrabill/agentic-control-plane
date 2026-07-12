import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_PRICE_BOOK_VERSION,
  defaultPriceBookPath,
  loadResolvedPriceBook,
} from '../src/index.js';

function writeBook(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-pricebook-'));
  const path = join(dir, 'book.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

const valid = {
  kind: 'acp-price-book/v1',
  version: '2099-01',
  currency: 'USD',
  fallback: {
    input_usd_per_mtok: 5,
    output_usd_per_mtok: 25,
    cache_read_usd_per_mtok: 0.5,
    cache_write_usd_per_mtok: 6.25,
  },
  models: {
    'known@1': {
      input_usd_per_mtok: 3,
      output_usd_per_mtok: 15,
      cache_read_usd_per_mtok: 0.3,
      cache_write_usd_per_mtok: 3.75,
    },
  },
};

describe('loadResolvedPriceBook', () => {
  it('loads and converts USD/MTok to integer micro-USD/MTok', () => {
    const book = loadResolvedPriceBook({ path: writeBook(valid) });
    expect(book.version).toBe('2099-01');
    expect(book.models['known@1']).toEqual({
      inputMicrosPerMTok: 3_000_000,
      outputMicrosPerMTok: 15_000_000,
      cacheReadMicrosPerMTok: 300_000,
      cacheWriteMicrosPerMTok: 3_750_000,
    });
    expect(book.fallback.inputMicrosPerMTok).toBe(5_000_000);
    expect(book.fallback.cacheWriteMicrosPerMTok).toBe(6_250_000);
  });

  it('rejects a missing fallback', () => {
    const { fallback: _omit, ...noFallback } = valid;
    expect(() => loadResolvedPriceBook({ path: writeBook(noFallback) })).toThrow(/invalid/);
  });

  it('rejects a negative rate', () => {
    const bad = structuredClone(valid);
    bad.fallback.input_usd_per_mtok = -1;
    expect(() => loadResolvedPriceBook({ path: writeBook(bad) })).toThrow(/invalid/);
  });

  it('rejects an unknown kind', () => {
    const bad = { ...valid, kind: 'acp-price-book/v2' };
    expect(() => loadResolvedPriceBook({ path: writeBook(bad) })).toThrow(/invalid/);
  });

  it('rejects an extra property', () => {
    const bad = { ...valid, surcharge: true };
    expect(() => loadResolvedPriceBook({ path: writeBook(bad) })).toThrow(/invalid/);
  });

  it('rejects a model entry missing a rate', () => {
    const bad = structuredClone(valid);
    // @ts-expect-error deliberately drop a required rate
    delete bad.models['known@1'].cache_write_usd_per_mtok;
    expect(() => loadResolvedPriceBook({ path: writeBook(bad) })).toThrow(/invalid/);
  });

  it('throws on malformed JSON', () => {
    expect(() => loadResolvedPriceBook({ path: writeBook('{ not json') })).toThrow(
      /could not be read or parsed/,
    );
  });

  it('throws on a missing file', () => {
    expect(() => loadResolvedPriceBook({ path: '/no/such/pricebook.json' })).toThrow(
      /could not be read or parsed/,
    );
  });

  it('loads the packaged current price book with the dev models priced', () => {
    const book = loadResolvedPriceBook({ path: defaultPriceBookPath() });
    expect(book.version).toBe(CURRENT_PRICE_BOOK_VERSION);
    expect(book.models['dev-echo@1']).toBeDefined();
    expect(book.models['dev-echo@1']?.inputMicrosPerMTok).toBe(1_000_000);
  });
});
