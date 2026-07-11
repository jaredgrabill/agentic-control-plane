# @acp/cloud-agent

Cloud Estate agent v0 (Phase 2 Item 3): read-only visibility into the acme
cloud estate over the `cloud-estate` MCP tool server.

## Capabilities (both R0)

- `cloud.inventory_query` — search the inventory snapshot by service, env,
  resource type, or region. At least one filter is required (`needs_input`
  otherwise).
- `cloud.cost_analysis` — week-over-week spend deltas. With a `service` it
  compares the latest complete week against the prior one; without, it
  analyses total spend and attributes any spike over `threshold_pct`
  (default 20) to the inventory changes behind it — the cost-spike half of
  the Phase 2 exit scenario.

## Design notes

- **Deterministic and extractive, zero-LLM**: answers are templated from
  tool data; the SDK's default FakeModel is never invoked
  (`usage.llm_calls === 0` is asserted in tests). Prompts arrive with
  synthesis later (`src/prompts/`).
- **No abstention in v0**: an empty result is a confident factual answer
  ("No resources match …"), cited against the snapshot — so
  `abstention_accuracy` gates trivially at 1.0. Confidence is 0.9 for
  complete data and 0.55 when the tool reports a partial window.
- **No retrieval**: `noRetriever('cloud-agent')` means the worker bootstrap
  skips NATS and token-exchange wiring — no NATS creds, no token-service
  client entry.
- **Citations come from tool provenance** (document granularity, fixed
  lineage IDs in `fixtures/acme-corp/cloud/`).
- Tool failures map onto the CapabilityError taxonomy in
  `@acp/tool-client` and propagate through the SDK's execute taxonomy —
  handlers never catch them.

## Evals

`evals/golden` (8 cases) and `evals/redteam` (2 cases) run hermetically in
`tests/evals.test.ts`: real MCP marshalling over `InMemoryTransport` against
`@acp/mock-tools`' cloud-estate server — the same fixture-serving
implementation the dev platform runs on :7301. Gates: every case passes,
citation precision ≥ 0.9, abstention accuracy = 1.0.

`src/eval-report.ts` emits the acp-eval-report/v1 document for the
Evaluation Service roster (`apps/evaluation/agents.json`); the committed
baseline lives at `evals/baseline.json` with zero-tolerance `evals/gate.json`
(the suite is fully deterministic).

## Running

```
pnpm --filter @acp/cloud-agent test    # unit + eval suites (hermetic)
node agents/cloud/dist/main.js         # Temporal worker (needs make dev + run-platform)
```

Env: `ACP_TOOL_SERVER_CLOUD_ESTATE_URL` (default `http://localhost:7301/mcp`)
plus the SDK's Temporal variables.
