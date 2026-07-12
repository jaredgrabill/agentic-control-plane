# @acp/cost-meter

Cost Meter v0: a versioned price book and deterministic, isolate-safe pricing
math for the orchestrator's cost ledger and `max_cost_usd` enforcement.

## Subpath exports

- `@acp/cost-meter` — node loader. `loadResolvedPriceBook`,
  `CURRENT_PRICE_BOOK_VERSION`, `defaultPriceBookPath`. Reads the filesystem;
  **never import from workflow (isolate) code.**
- `@acp/cost-meter/pricing` — pure math. `priceUsageMicros` and the
  `ResolvedPriceBook` / `ModelRateMicros` / `PricedUsage` types. Zero node
  imports, safe inside a Temporal workflow bundle.

## Price book

`pricebooks/<version>.json`, format `acp-price-book/v1`. Keys are concrete
model ids (post-gateway resolution, e.g. `dev-echo@1`), each carrying four
USD/MTok rates: input, output, cache read, cache write. A required `fallback`
prices usage whose model is missing or unknown. Books are immutable once
merged; a price change is a new dated file plus a bump of
`CURRENT_PRICE_BOOK_VERSION`. The version used is recorded in the task audit.

## Math

All arithmetic is integer micro-USD (1e-6 USD). The node loader converts
USD/MTok → micro-USD/MTok (`Math.round(x * 1e6)`) on the activity side; the
isolate only ever sees integers. Per component the cost is
`ceil(tokens · rate_micros_per_mtok / 1e6)` — the meter never undercounts.
Zero or absent tokens cost zero, so a zero-LLM agent is free.
