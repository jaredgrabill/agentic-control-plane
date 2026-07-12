/**
 * Cost Meter node entrypoint: the price book loader plus the current book
 * version and its packaged path. Workflow (isolate) code must NOT import this
 * module — it reads the filesystem. Deterministic workflow code imports the
 * pure math from `@acp/cost-meter/pricing` instead; the orchestrator's
 * `bundleWorkflowCode` test fails if this module ever leaks into the bundle.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type { ModelRateMicros, PriceResult, PricedUsage, ResolvedPriceBook } from './pricing.js';
export { priceUsageMicros } from './pricing.js';
export { loadResolvedPriceBook } from './pricebook.js';

/**
 * The current price book version. A price change is a NEW dated file plus a
 * bump here — books are immutable once merged, so a task's recorded
 * `price_book_version` always maps to an exact, reproducible rate table.
 */
export const CURRENT_PRICE_BOOK_VERSION = '2026-07';

/** Absolute path to the packaged current price book (adjacent to dist/ and src/). */
export function defaultPriceBookPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'pricebooks', `${CURRENT_PRICE_BOOK_VERSION}.json`);
}
