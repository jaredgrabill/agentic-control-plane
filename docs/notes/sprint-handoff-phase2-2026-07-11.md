# Sprint Handoff — Phase 2 Complete (2026-07-11)

State of the world after the Phase 2 (Composition & Evaluation) sprint. Read
alongside [ROADMAP.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/ROADMAP.md),
the [Phase 0+1 handoff](sprint-handoff-2026-07-11.md), and
[ADR-0007](../adr/0007-orchestrator-identity-broker.md).

## Where things stand

The five Phase 2 work items are **implemented and locally green** (unit,
contract, workflow, eval, parity, policy, and the full four-file E2E suite
against the dev stack), delivered as a 5-branch stack continuing the Phase 1
PR stack, each branch based on the previous:

| Branch | Contents |
|---|---|
| `feat/p2-ts-sdk` | `@acp/agent-sdk` (1:1 port of the Python SDK, same `execute_capability` contract), `@acp/create-agent` scaffolder, cross-SDK **parity gate** (`fixtures/parity` + `tests/parity` + `python/parity` + ci job); `expect.error_class` added to both harnesses (fixed a real scaffolder-template bug found during design) |
| `feat/p2-eval-service` | Evaluation Service v0: `eval-report` protocol schema (report + baseline shapes), `PUT /v1/agents/:id/baseline` + `agent.baseline_recorded` audit, `suite_digest`/`report_payload` in both SDKs (byte-identical digests), `apps/evaluation` gate CLI, committed per-agent baselines with digest-guarded re-baselining, ci `evals` job with the inverted "regressed change is blocked" proof |
| `feat/p2-ts-agents` | `@acp/tool-client` (ToolClient seam, MCP client, error taxonomy mapping), `deploy/mocks` (cloud-estate + code-forge mock MCP servers with scripted failure modes), `agents/cloud` + `agents/code` (R0, deterministic, zero-LLM, eval-gated at 1.0/1.0/1.0), acme-corp cloud/code fixture estate with the cost-spike storyline |
| `feat/p2-orchestrator-v1` | ADR-0007 identity broker (`POST /v1/token/delegate`, broker role, principal snapshot at intake, per-step token minting — debt #2 resolved), typed `Plan`/`PlanStep` artifacts + `task.planned`/`step.skipped`/`token.brokered` audit events, deterministic `rule-planner@1`, parallel fan-out with dependency waves, partial results with `gaps`, delegation depth cap (3), `max_steps`/`max_tokens` budget enforcement |
| `feat/p2-tool-gateway` | `apps/tool-gateway` (port 7106): MCP-terminating proxy enforcing authN → kill switch → allowlist → Cedar (`tool:{server}:{tool}` actions) → rate limit → schema validation → credential brokering → `tool.called` audit; knowledge corpus behind standard MCP (`POST /mcp` on apps/knowledge over the existing SearchService PEP); agents cut over to the gateway with delegated-token forwarding; six new Cedar permits (the Item-3 agent→tool deny-pin flipped consciously with its paired outside-scope deny) |

E2E suite (all against the live compose stack): `exit-scenario` (Phase 1
regression, 8), `tool-agents` (7), `orchestrator-v1` (5), `tool-gateway` (4).
The composite "Why did cloud spend jump last week?" task plans two steps,
fans out to cloud-agent + code-agent in parallel through the tool gateway,
and returns a sectioned, cited answer naming `payments-api`, the 30.0% spike,
and deploy `d-2026-07-01-042` — with `task.planned`, per-step
`token.brokered`, and per-call `tool.called` audit events joined by task_id.

Every item went through design → implementation → adversarial QA subagents;
QA findings (latent parity string-format breaks, a silently-swallowed gate
config, a broker scope-narrowing gap for toolless agents) were fixed on the
branches before stacking the next item.

## Merge procedure

Same as Phase 1: merge **bottom-up, one at a time** (`feat/p2-ts-sdk` first,
on top of the merged Phase 1 stack). Prefer merge commits or rebase-merge
over squash. The `contracts` job gates regenerated bindings; the `parity`
and `evals` jobs are new required checks worth adding to branch protection.

## Known debts (decided, not forgotten)

1. **NATS auth callout still static per-service users** (debt #1 from Phase 1,
   unchanged). The TS agents deliberately avoid NATS entirely (`noRetriever`),
   so no new static agent creds were added — but the callout work is still
   owed before dynamic agents ship.
2. **Tool gateway accepts `acp:agent:*` audiences** (with an aud↔act.sub
   consistency check) because TS agents hold no token-service credentials.
   Phase 3 tightens to `acp:tools`-only once per-agent identities exist.
   Documented in the gateway README and design notes.
3. **Rate limiting is in-memory per gateway instance**; distributed limiting
   (NATS KV/Redis) is Phase 3.
4. **`max_cost_usd` is recorded, not enforced** — needs the Cost Meter price
   book (Phase 2 roadmap item not in this sprint's five tasks).
5. **Registry re-registration still resets lifecycle_state and now also drops
   `eval_baseline`** (debt #3 — **CLOSED in Phase 3 item 4**): the registry is
   now versioned (one card per `(agent_id, version)`, DB-enforced one-active /
   one-candidate invariants), so a new-version registration never touches a
   sibling's card or baseline, and `eval_baseline` is load-bearing per version
   for the deployment gates. The legacy single-row `agents` table is migrated
   forward and dropped on boot.
6. **LLM planner / LLM gateway not started**: `rule-planner@1` produces
   exactly three plan shapes (explicit capability, cost-forensics composite,
   knowledge default). The LLM planner swaps the `planTask` implementation
   behind the same `plan.parse` validation seam.
7. **Windows: `run-platform.mjs` can orphan the Python knowledge-agent
   worker** (`taskkill /T` loses the `uv → python` grandchild). Orphaned
   old-protocol workers polling the same Temporal queue caused one confusing
   E2E failure this sprint. Worth a follow-up before it costs someone a day.
8. **Known cross-SDK divergences, documented not fixed**: whole-number
   min_confidence/confidence values are not parity-safe (JS `String(1)` vs
   Python `str(1.0)`); capability `format:` keywords are annotation-only in
   both SDKs by construction.

## What Phase 2 (roadmap) still has open

This sprint covered the five handoff items. Remaining Phase 2 roadmap lines:
Discovery v1 (semantic ranking), Cost Meter v0, LLM gateway v1, ingestion v1
(event-driven triggers + reconciliation sweep), red-team-as-blocking-gate
(gate 3) and the calibrated judge harness, and the full cost-spike-forensics
exit scenario as a standing E2E eval (its ground truth and the two composing
agents now exist; the Change-agent record linkage does not).

## Gotchas that cost time this sprint

- `@modelcontextprotocol/sdk` types clash with `exactOptionalPropertyTypes`
  (`T | undefined` vs optional props) — a few `as Transport` casts are
  deliberate and commented.
- Fastify parses the JSON body before the MCP transport sees it — pass
  `request.body` as the third argument of `transport.handleRequest`.
- The parity comparator matches failure strings byte-for-byte; the
  string-formatting constraints live in `fixtures/parity/HANDLERS.md`.
- The evals CI job's regression proof requires exit code **exactly 1** plus a
  violation substring — a crash (also nonzero) fails the step; keep it that
  way.
- Docker compose config changes (the NATS tool-gateway user) require
  `docker compose up -d` to recreate the NATS container before E2E.
