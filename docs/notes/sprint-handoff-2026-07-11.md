# Sprint Handoff — Phase 0+1 Complete (2026-07-11)

State of the world for whoever picks up the next sprint (Phase 2 —
Composition & Evaluation). Read alongside
[ROADMAP.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/ROADMAP.md)
and the [architecture overview](../architecture/overview.md).

## Where things stand

Phase 0 (foundations) and Phase 1 (walking skeleton) are **implemented and
CI-green**, delivered as a 12-PR stack (#1–#12) on
`jaredgrabill/agentic-control-plane`, each PR based on the previous:

| PR | Branch | Contents |
|---|---|---|
| 1 | `feat/p0-monorepo-scaffold` | pnpm+Turborepo / uv workspaces; `packages/protocol` with dual TS+Pydantic codegen and cross-language contract fixtures |
| 2 | `feat/p0-ci` | ci/scorecard/release-please workflows, gitleaks config, commitlint |
| 3 | `feat/p0-dev-stack` | docker-compose substrate (NATS accounts, Temporal, pgvector, OTel→Jaeger), `make dev`, acme-corp corpus v0 |
| 4 | `feat/p1-token-service` | EdDSA JWT issuance, JWKS, RFC 8693 exchange; `@acp/service-kit` |
| 5 | `feat/p1-gateway` | authN, attribution stamping, kill-switch gate, task submission |
| 6 | `feat/p1-registry` | signed agent cards, lifecycle states, NATS announcements, KV cache |
| 7 | `feat/p1-policy` | Cedar PDP, default deny, git-versioned bundle + golden policy suite |
| 8 | `feat/p1-orchestrator` | TaskWorkflow/AgentStepWorkflow, policy-gated polyglot dispatch |
| 9 | `feat/p1-audit` | deny-delete JetStream → append-only Postgres, provenance API |
| 10 | `feat/p1-knowledge` | lineage-ledgered ingestion, hybrid RRF retrieval, citations |
| 11 | `feat/p1-python-sdk` | `acp-agent-sdk` alpha + `acp-create-agent` scaffolder |
| 12 | `feat/p1-knowledge-agent-e2e` | knowledge agent + evals, kill-switch CLI, exit-scenario E2E, e2e workflow |

The Phase 1 exit scenario passes in GitHub Actions (the `e2e` workflow):
real-JWT cited answer from the acme-corp corpus, audit delegation chain
`user → orchestrator → agent`, one trace across
gateway → workflow → agent → retrieval, agent suspension stopping new
traffic in <10s.

## Merge procedure

Merge **bottom-up, one at a time** (#1 first). GitHub automatically
retargets each child PR onto the new base as its parent merges. Prefer
merge commits or rebase-merge over squash to keep the Conventional Commit
subjects release-please expects. After #1 merges to main, release-please
will open its first release PR — expected behavior, park it until the
whole stack lands.

Repo settings still to apply by an admin (not automatable from this side):
branch protection on `main` requiring the `ci` checks and up-to-date
branches, plus 2-approval rule once there are two humans.

## Bootstrapping a dev machine

```bash
# prerequisites: Docker, Node 22, pnpm 11, uv, GNU make
make dev                      # substrate up + readiness gates
pnpm install && pnpm build
cd python && uv sync && cd ..
pnpm test                     # TS unit/contract/workflow suites
cd python && uv run pytest && cd ..
make e2e                      # full exit scenario against the dev stack
make platform                 # or: run all services + agent interactively
```

Windows notes: shells opened before the tooling install may need
`$LOCALAPPDATA\Microsoft\WinGet\Links` on PATH for `uv`/`make`; platform
processes must be tree-killed (`taskkill /T`) or the next run hits
EADDRINUSE — `scripts/run-platform.mjs` and the E2E already handle this.

## Known debts (decided, not forgotten)

1. **NATS auth callout is still static per-service users** (dev profile).
   ADR-0001 calls for callout minting session-scoped bus identities from
   platform JWTs. Contained piece of work; do it before a second agent
   ships so dynamic agents never need static bus creds.
2. **`subject_token` forwarding caps task duration at the 15-min token
   TTL.** Fine for single-step Phase 1 tasks; Phase 2's plan-then-execute
   will breach it. Needs a short design note (orchestrator as identity
   broker / re-authentication point) before orchestrator v1 work starts.
3. **Registry re-registration resets `lifecycle_state` to `registered`.**
   Acceptable while CI is the only registrar; revisit with the Deployment
   Controller (Phase 3) which owns promotion.
4. **Coverage strategy:** infra adapters (Postgres stores, NATS loops,
   worker bootstraps) are excluded from unit coverage and owned by the
   E2E. This already caught one real bug (registry `list()` dropping its
   query params). If the E2E ever gets flaky, that tradeoff needs
   revisiting before trimming the suite.
5. **GitHub Actions run with Node-20 deprecation warnings.** All actions
   are SHA-pinned; bumping to the next majors (checkout v5 etc.) is a
   mechanical follow-up — re-pin SHAs when doing it.
6. **gitleaks cannot comment on PRs** (`Resource not accessible by
   integration`) — findings still fail the job and land in the run
   summary. Grant `pull-requests: write` to the security job if comments
   are wanted.
7. **Dev-only simplifications marked in code/commits:** single app NATS
   account with per-user subject permissions (per-tenant accounts are
   Phase 4), `dev-hash-embed@1` deterministic embeddings (real provider
   slots in behind the `Embedder` interface + model-version column),
   extractive answer synthesis (LLM-polished synthesis arrives with the
   Phase 2 LLM gateway without touching the gated citation/abstention
   metrics).

## Phase 2 sprint plan (roadmap order, first tasks concrete)

1. **TypeScript SDK alpha (`@acp/agent-sdk`) + `create @acp/agent`** —
   port the Python SDK surface 1:1 (Agent/Capability/ModelClient with
   FakeModel/Retriever/AnswerBuilder/EvalHarness, same
   `execute_capability` activity contract). Add the **parity gate**: a CI
   job running the same golden cases through both SDKs' harnesses.
2. **Evaluation Service v0** — golden-set runner in CI writing baselines
   into the registry record (`eval_baseline` field already exists on the
   agent card), plus the "deliberately-regressed change is blocked"
   gate test. The Python `EvalHarness` semantics are the reference.
3. **Cloud agent v0 and Source Code agent v0 (TS)** — first consumers of
   the TS SDK; R0 capabilities against mock tool servers in
   `deploy/mocks` (build the mock MCP servers as part of this).
4. **Orchestrator v1** — plan-then-execute with typed plan artifacts,
   parallel fan-out, partial-results semantics (the `gaps` field in
   TaskResult is already in the protocol), delegation depth cap, per-task
   budget enforcement (Budget already rides the contract). Resolve debt
   #2 first.
5. **Tool gateway v1 + first real MCP tool server** — the Knowledge
   Service already exposes the pattern (policy check + audit at the
   boundary); generalize it and put the corpus behind standard MCP.

Sequencing principle to preserve: evals (2) land before any agent gets a
write capability, and both SDKs stay honest via the parity gate (1).

## Gotchas that cost time this sprint

- `@temporalio/interceptors-opentelemetry` is built against the OTel 1.x
  SDK line: the orchestrator worker's `sinks.exporter` uses the
  `otel-legacy-*` npm aliases, and the workflow interceptor module is
  `lib/workflow-interceptors` (NOT `lib/workflow` — the wrong path fails
  silently and fractures traces at every workflow→activity edge).
- Type-aware ESLint needs built workspace deps: `lint`/`typecheck`/`test`
  all `dependsOn: ["^build"]` in turbo — don't remove that.
- `pnpm gen` is deliberately NOT part of `build` (it needs uv); the
  `contracts` CI job diff-gates generated-binding freshness instead.
- Cedar policy evaluation fails **closed**; when a delegation is denied
  unexpectedly, check which scopes the PEP actually sent (`context.scopes`
  is the principal's verified scopes, `requested_scopes` the manifest's).
