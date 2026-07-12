# Cost Management

FinOps discipline is built into the request path, not bolted on at invoice
time. Principles from the FinOps Foundation's AI framework: unit economics,
attribution before optimization, showback before chargeback.
Research basis: [observability-eval-cost brief](../research/observability-eval-cost.md).

## Attribution First

Nothing can be optimized, budgeted, or charged until we know who spent what:

- The Gateway stamps every task with **tenant, principal, session, feature**;
  the orchestrator adds **agent version and capability** per step. These ride
  OTel span attributes (`acp.*`) — one tagging scheme for cost, audit, and
  debugging.
- The **Cost Meter prices spans at close** from `gen_ai.usage.*` tokens ×
  a versioned price book (per model, including cache-read/write and batch
  rates). Prices change; the price book is versioned so historical costs
  stay honest.
  *Status:* Cost Meter v0 (`@acp/cost-meter`) ships the versioned price
  book and deterministic pricing math. The book (`pricebooks/<version>.json`,
  format `acp-price-book/v1`) is keyed on concrete post-gateway model ids
  with input/output/cache-read/cache-write USD-per-MTok rates plus a required
  fallback for unknown/absent models; all pricing runs in integer micro-USD.
  **Versioning policy:** books are immutable once merged — a price change is a
  new dated file plus a bump of `CURRENT_PRICE_BOOK_VERSION`, and the version
  used is recorded per task in `task.completed`. The orchestrator prices its
  own ledger from usage (§Budget Enforcement); OTel span-at-close pricing,
  hourly/daily rollups, batch rates, and eval/shadow cost centers are
  deferred past v0.
- Rollups: real-time (budget enforcement) → hourly (dashboards) → daily
  (chargeback source of truth, exportable to corporate FinOps tooling).

**Unit economics are the headline metrics:** cost per completed task, per
agent, per capability, per tenant — not raw spend. A cost SLO
(cost-per-task envelope) is part of every agent's SLA and a canary
promotion gate.

## Budget Enforcement

Hierarchical budgets with hard edges:

```
org → tenant → team/feature → agent → task
```

- **Task-level:** every task carries a token/step budget in workflow state —
  the runaway-loop backstop. Exhaustion is a clean, reportable outcome
  ("budget exhausted after step 7"), not an OOM-style surprise.
  *Status:* Orchestrator v1 enforces `max_steps`, `max_tokens`, and
  `max_cost_usd` at dispatch-gating (in-flight steps of a parallel wave
  complete and are kept, so any budget can overshoot honestly by in-flight
  usage). `max_cost_usd` is priced from the Cost Meter book: the orchestrator
  fetches the book once per task, pins its version, prices each wave's usage
  after it completes, and records `cost_usd` + `price_book_version` (and a
  `cost_fallback_priced` flag) in `task.completed`. If the book is unavailable
  it fails **closed** when `max_cost_usd` is set (the budget can't be honored)
  and otherwise proceeds with cost recording disabled. v0 caveat: a step's
  cost is priced on `usage.model` (last-write-wins across a step's completions
  — no multi-model blending); cache tokens are priced at cache rates and do
  not count toward `max_tokens`.
- **Agent/tenant/org-level:** enforced at the Gateway and LLM gateway.
  Soft threshold (80%) → alerts; hard cap → structured rejection clients can
  degrade on gracefully. Caps auto-reset per window (monthly by default).
- Budgets live in the control KV — adjustable in seconds, auditable, no
  redeploy.
- **Eval and shadow traffic is metered separately** (platform cost center)
  so quality machinery never silently eats tenant budgets — and its cost is
  visible, because evaluation at 5–10% sampling plus shadow soaks is a real
  line item that must be defended on merit.

## Optimization Levers (priority order)

1. **Prompt caching** — highest leverage, lowest risk. The SDK enforces
   cache-aware prompt layout (static system prompt and tool schemas first,
   volatile context last); the LLM gateway manages provider cache features.
   Cache hit rate is a per-agent dashboard metric.
   *Status:* LLM Gateway v1 makes the layout structural — the wire shape
   separates static from variable, assembly is strictly prefix-first, the
   prefix digest rides every span (`acp.llm.prefix_digest` /
   `acp.llm.prefix_stable`), and the anthropic adapter sets ephemeral
   cache breakpoints; the dev provider simulates cache accounting.
2. **Model routing** — manifests declare model *classes*
   (`default-tier`, `reasoning-tier`, `cheap-tier`), the LLM gateway binds
   classes to concrete models. Small-model-first with escalation-on-failure
   for classifiable steps (routing, extraction, summarization). Class
   rebinding is a config change — when a cheaper model clears the eval bar,
   the fleet moves without code changes, and *eval gates apply to model
   changes exactly as to prompt changes*.
   *Status:* LLM Gateway v1 ships the versioned `acp-model-classes/v1`
   registry (`deploy/dev/model-classes.json`) with intra-call provider
   failover; `llm.complete` spans carry `gen_ai.usage.*` and the registry
   version — the Cost Meter's (0b) pricing record.
3. **Batch APIs** — non-interactive workloads (ingestion embedding, offline
   evals, corpus reprocessing) route to provider batch endpoints (~50%
   discount) via dedicated task queues.
4. **Semantic caching** — opt-in per capability for FAQ-shaped R0 traffic,
   with conservative similarity thresholds and eval-monitored false-hit
   rates. Never for R1+.
5. **Context discipline** — orchestrator-worker pattern returns conclusions,
   not transcripts ([orchestration.md](orchestration.md)); retrieval k and
   chunk budgets are tuned per capability with eval feedback.

## Cost Observability

- Per-agent cost dashboards auto-provisioned at registration (tokens, $,
  cache hit rate, model mix, cost/task trend).
- **Anomaly detection:** cost-per-task deviation alerts (a prompt regression
  that doubles token use pages before the invoice does).
- Showback reports per team/tenant from day one; chargeback becomes a
  configuration choice once trust in the numbers is established.
  *Status:* Cost Meter v0 ships `scripts/showback.mjs <tenant> [--since]`,
  an audit-derived rollup (total cost, cost/task, per-capability breakdown,
  fallback-priced count) read from the durable `task.completed` stream. Auto-
  provisioned dashboards and anomaly detection are deferred past v0.
- Canary gates include cost: a version that's 2× cost for 1% quality doesn't
  promote by default — that trade needs a human's signature.
