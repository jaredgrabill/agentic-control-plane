# @acp/code-agent

Source Code agent v0 (Phase 2 Item 3): read-only visibility into the acme
source forge over the `code-forge` MCP tool server.

## Capabilities (both R0)

- `code.dependency_query` — direct, transitive (BFS, deduped), or reverse
  (dependents) dependency edges for a repo. The repo shape is validated
  before any tool call (`needs_input` on anything that is not `org/name`).
- `code.ci_health` — CI pass rate and deploy activity over a trailing
  window (`window_days`, default 14) anchored on the snapshot's `as_of`
  date, never the wall clock. The deploy linkage
  (`d-2026-07-01-042`) is the code half of the Phase 2 exit scenario.

## Design notes

- **Deterministic and extractive, zero-LLM**: answers are templated from
  tool data; the SDK's default FakeModel is never invoked
  (`usage.llm_calls === 0` is asserted in tests).
- **No abstention in v0**: a repo with zero CI runs gets a confident
  factual answer ("no CI runs since …"), cited — `abstention_accuracy`
  gates trivially at 1.0. Confidence is 0.9 (0.55 on partial tool data).
- **No retrieval**: `noRetriever('code-agent')` — no NATS creds, no
  token-service client entry.
- **Aggregation is capability logic**: the ci_runs tool returns raw runs;
  the handler computes the window and the pass rate.
- Tool `not_found` (unknown repo) maps to `needs_input` via
  `@acp/tool-client`'s normative error table and propagates untouched.

## Evals

`evals/golden` (8 cases) and `evals/redteam` (2 cases) run hermetically in
`tests/evals.test.ts` over `InMemoryTransport` against `@acp/mock-tools`'
code-forge server (the same implementation the dev platform runs on :7302).
The red-team fixture includes an injection-flavored commit message — the
agent reports it as data, never obeys it. Gates: every case passes,
citation precision ≥ 0.9, abstention accuracy = 1.0.

`src/eval-report.ts` emits the acp-eval-report/v1 document for the
Evaluation Service roster (`apps/evaluation/agents.json`); the committed
baseline lives at `evals/baseline.json` with zero-tolerance `evals/gate.json`.

## Running

```
pnpm --filter @acp/code-agent test    # unit + eval suites (hermetic)
node agents/code/dist/main.js         # Temporal worker (needs make dev + run-platform)
```

Env: `ACP_TOOL_SERVER_CODE_FORGE_URL` (default `http://localhost:7302/mcp`)
plus the SDK's Temporal variables.
