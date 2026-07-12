/**
 * Pure, isolate-safe pricing math. This module imports NOTHING from node or
 * from any package that does — it is the only Cost Meter surface a Temporal
 * workflow may import (`@acp/cost-meter/pricing`). All arithmetic is on
 * integer micro-USD, so pricing inside the deterministic V8 isolate never
 * touches a float. The node-side loader (`pricebook.ts`) converts the
 * USD/MTok price book to the integer-micros shapes below before the book
 * ever crosses into the isolate.
 */

/** Per-model rates, in integer micro-USD per million tokens. */
export interface ModelRateMicros {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  cacheReadMicrosPerMTok: number;
  cacheWriteMicrosPerMTok: number;
}

/**
 * A price book resolved to integer micro-USD rates — safe to hold in workflow
 * state and to price against inside the isolate. `version` is recorded in the
 * task audit so a completed task's cost is reproducible from the exact book.
 */
export interface ResolvedPriceBook {
  version: string;
  models: Record<string, ModelRateMicros>;
  fallback: ModelRateMicros;
}

/**
 * The subset of `$defs.usage` the meter prices on. Kept local (not imported
 * from `@acp/protocol`) so this module stays dependency-free; the protocol
 * `Usage` type is structurally assignable to it.
 */
export interface PricedUsage {
  model?: string | undefined;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_read_tokens?: number | undefined;
  cache_write_tokens?: number | undefined;
}

export interface PriceResult {
  /** Cost in integer micro-USD (1e-6 USD). Divide by 1e6 only at audit edges. */
  micros: number;
  /** True when the usage's model was unknown to the book and fallback rates were used. */
  fallbackUsed: boolean;
}

/**
 * Prices one step's usage. Each token component is charged independently and
 * rounded UP (`Math.ceil`) so the meter never undercounts a sub-micro sliver.
 * Zero or absent tokens cost zero — a zero-LLM agent is free even if its
 * (absent) model is unknown, and `fallbackUsed` is reported false in that case
 * because no fallback rate was consulted.
 */
export function priceUsageMicros(
  usage: PricedUsage | undefined,
  book: ResolvedPriceBook,
): PriceResult {
  if (usage === undefined) return { micros: 0, fallbackUsed: false };

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;

  // Nothing was processed — no cost, no book lookup.
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) {
    return { micros: 0, fallbackUsed: false };
  }

  const known = usage.model !== undefined ? book.models[usage.model] : undefined;
  const rate = known ?? book.fallback;
  const micros =
    componentMicros(input, rate.inputMicrosPerMTok) +
    componentMicros(output, rate.outputMicrosPerMTok) +
    componentMicros(cacheRead, rate.cacheReadMicrosPerMTok) +
    componentMicros(cacheWrite, rate.cacheWriteMicrosPerMTok);

  return { micros, fallbackUsed: known === undefined };
}

/** ceil(tokens · micros_per_mtok / 1e6); zero when either factor is non-positive. */
function componentMicros(tokens: number, rateMicrosPerMTok: number): number {
  if (tokens <= 0 || rateMicrosPerMTok <= 0) return 0;
  return Math.ceil((tokens * rateMicrosPerMTok) / 1_000_000);
}
