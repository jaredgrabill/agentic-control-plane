# Sprint Handoff — Phase 3 Complete (2026-07-12)

State of the world after the Phase 3 (Write Actions & Hard Governance) sprint.
Read alongside [ROADMAP.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/ROADMAP.md),
the [Phase 2 handoff](sprint-handoff-phase2-2026-07-11.md), and
[ADR-0007](../adr/0007-orchestrator-identity-broker.md).

## Where things stand

The nine Phase 3 work items are **implemented and locally green** (build, lint,
typecheck, unit/contract/workflow, parity, evals, and each item's own E2E file
run individually against the dev stack). Delivered as a **9-branch stack**
continuing the Phase 1/2 PR stacks, each branch based on the previous:

| Branch | Tip | Contents |
|---|---|---|
| `feat/p3-llm-gateway` | d4ee1cc | LLM gateway v1 (`apps/llm-gateway` :7107): versioned model-class registry, provider failover, prompt-caching layout enforcement, dev + anthropic providers, `@acp/llm-client`, SDK `GatewayModel` bound only in `serveAgent`/`run()` (FakeModel stays the unit seam); `model.invoked` audit |
| `feat/p3-cost-meter` | 5ae6089 | Cost Meter v0: `@acp/cost-meter` versioned price book (integer micro-USD, isolate-safe pure pricing subpath), task-level `max_cost_usd` enforcement at dispatch (honest overshoot), fail-closed when book unavailable, `cache_read/write_tokens` on usage, showback script |
| `feat/p3-bus-identity` | 86cb638 | NATS auth callout (session bus identities from platform JWTs, aud `acp:bus`; responder in the token service; TENANT_ACME static user deleted); per-agent token clients + SDK RFC 8693 exchange to `acp:tools`; tool-gateway audience flip to `acp:tools`-only + orchestrator-chain check; ADR-0007 broker-time principal denylist (`killswitch.principal.{sub}`, base64url KV key) |
| `feat/p3-approvals` | 63689a3 | Three-way Cedar PDP (`@decision("require-approval")` annotation-lift, restrictive), `ApprovalWorkflow` (wait_condition, escalation, timeout-DENY), approval API + `scripts/approve.mjs` with full context, rubber-stamp metrics, approval audit events, signed `approval` token claim; `stableStringify` → `@acp/service-kit` |
| `feat/p3-compensation` | debde8e | Saga compensation stack (LIFO unwind on failure/cancel/kill-switch), cancellation shield (nonCancellable → honest `cancelled` result), compensator-or-irreversible registration rules extended, `task.cancel_requested` gateway endpoint, signed `compensation` token claim + `permit-compensation` Cedar carve-out |
| `feat/p3-change-agent` | 1c2d27c | Change/ITSM agent v0 (deterministic TS: change.conflict_check R0, change.draft R1, change.submit/withdraw R2 mutual pair); mock ITSM server (:7303) with idempotency + dry_run; cloud tag_apply/tag_restore (restore-previous-value); tool-gateway **risk-class enforcement** (step 3.5) via signed `capability{name,risk}` claim; Cedar pair-policies for R2 tools |
| `feat/p3-deployment-controller` | 66df6fc | Deployment Controller v0: `DeploymentWorkflow` (shadow→canary auto-ramp→promote/rollback/demote, deterministic gates), **versioned registry cards** (`agent_versions` table, one-active/one-candidate DB invariants, atomic `/promote` — closes debt #3), version-aware routing + session pinning, shadow side-effect suppression (tool-gateway step 2.5) via signed `deployment{mode:shadow}` claim, version-qualified task queues, owner-approval reuse |
| `feat/p3-killswitch-audit` | a1cfccd | Kill-switch tiers 2 (capability/risk) + 3 (fleet auto-canceller); **Audit v1**: per-tenant hash chain (consumer-computed, Postgres BEFORE-INSERT chain-check trigger, tamper-evident, `/v1/verify`), task-reconstruction API+CLI, retention floor; drill runbooks; all kill-switch refusals now audited |
| `feat/p3-online-eval` | 7cc8ad6 | Online Evaluation v0: `@acp/judge` calibrated harness (fail-closed calibration gate), `@acp/embedding`, `@acp/online-eval`; `apps/evaluation` `serve` mode (:7108) — sampled judge scoring (ABANDON child), synthetic probes (`ProbeWorkflow`), drift joint-condition, quality error budget → fail-closed change-freeze → degradation ladder → auto-suspend; **fills the deployment-gate `quality` seam** (calibrated judge scores the real output, closing the gameable-gates gap) |

85 commits over `main`. Each item went through **design (Plan agent) →
implementation → adversarial opus security QA → scoped fixes**; every trust
boundary (approvals, compensation, write capabilities, bus/token identity,
audit integrity, auto-suspend) got a dedicated security review.

### Security campaign result
**Nine items, adversarial opus review on all, zero confirmed vulnerabilities
that survived.** Three MEDIUMs surfaced and were closed in-flight: the
ADR-0007 principal-denylist completeness gap (folded into item 1), and the
online-eval cross-tenant auto-suspend DoS (fixed to require golden-probe
corroboration for the irreversible suspend, leaving attacker-influenceable
judge-burn to drive only the reversible freeze). Everything else was
LOW/INFO/nits, routed to the consolidation punch list or accepted as
documented residuals.

### The governance-claim invariant (load-bearing across items 0c–4)
Approval/compensation/capability/deployment grounds ride **signed
broker-minted JWT claims**; `TokenIssuer.exchange()` propagates them verbatim
**only across the same-actor narrowing branch** (`subject.act?.sub === actor`)
and drops them on any actor-append or chain-free rescope; body-supplied claims
are rejected 400. This is what keeps every governance binding intact across an
agent's per-call `acp:agent → acp:tools` exchange (post the 0c audience flip),
so the tool gateway can trust the claims on the exchanged token.

## Acceptance scenarios (the DoD)
- **Scenario 4 — governed patch rollout** (`tests/e2e/src/governed-writes.test.ts`,
  5/5): gated ITSM `change.submit` (R2, human approval), real-tool compensation
  unwind (`change.withdraw`), honest tag inverse, risk-laundering refusal.
- **Deployment lifecycle** (`tests/e2e/src/deployment.test.ts`, 2/2):
  shadow candidate promotes to active with zero manual routing; failed
  candidate auto-rejects, incumbent keeps serving.
- Both pass **individually** on the dev stack. See the E2E note below.

## E2E on this machine (important)
The dev box is 16 GB; the docker stack baselines ~11 GB, and each E2E file
spins the **entire** platform (~15 node + python workers, webpack-bundling the
3.3 MB orchestrator workflow) via its own beforeAll/afterAll. Running the full
9-file suite in one invocation reliably OOMs a random worker (symptom:
`[svc] exited with 4294967295` → vitest exit 127) or leaves orphans holding
ports (`EADDRINUSE`). **Single-file runs pass reliably on a clean slate.** The
authoritative full-suite E2E is **CI** (`e2e.yml`, fresh runner per job) — the
"all CI green including E2E" DoD criterion is verified there, not locally.
When running E2E locally: kill node/python + wait before/after each file;
capture the real vitest exit via file-redirect (a `| grep` pipe makes `$?` the
grep exit, not vitest's); grep for `exited with`/`EADDRINUSE` (infra) vs
`AssertionError` (real). `exit-scenario` assumes a fresh corpus + audit stream
(a volume wipe, which CI provides per run).

## Known debts / consolidation punch list (decided, not forgotten)
Apply during the pre-merge consolidation rebase:
1. **Worktree pollution (merge-blocking):** item-3 commit `213342d` committed
   ~271 files under `.claude/worktrees/**` (a stale QA-worktree checkout;
   `.claude/` was not gitignored). Item 4 gitignored `.claude/` + purged it
   (`ed190eb`), so item-4→6 tips are clean, **but item-3's tip still tracks
   them** → rewrite item-3's history to drop them before the bottom-up merge,
   else `main` transiently gets the pollution.
2. **0a hardening:** dev-provider prod guard (**required before online-eval
   judged scoring runs against real traffic** — see item-6 F2), Python
   response-validation parity, `act.sub` defensive typing, make
   `CoreDeps.killSwitch` required, class-enumeration tighten/accept.
3. **0c LOWs:** reject array-aud in the bus callout; drop header-less requests
   when xkey is set; `token.denied` audit key comment.
4. **Platform-service-scope tenant-param boundary** (item-4 F1 + item-5 #1,
   same pattern): `deploy:write` / `audit:read` trust the caller-supplied
   `tenant` param. NOT attacker-reachable in v0 (platform-service-only scopes),
   but add defense-in-depth `assert claims.tenant === q.tenant` and document
   the boundary in governance-and-policy.md before these scopes are ever
   delegated to tenant operators.
5. **Nits:** dead `min_shadow_samples` field; `ramp_from` in
   `agent.lifecycle_changed`; probes pin to ACTIVE only; real-pg tests for the
   registry invariants and the audit-chain numeric round-trip; online-eval
   `default_percent` must be > 0 in prod (dev fails open by design).
6. **Documented residuals:** approvals bind at step granularity (agent trusted
   with exact tool-call args within an approved step); compensator input
   `original.output` is agent-recorded; `compensation.status='complete'` can
   coexist with a non-empty `irreversible[]`.

## Merge procedure
Same as Phase 1/2: merge **bottom-up, one at a time** (`feat/p3-llm-gateway`
first, on the merged Phase 2 stack). Merge commits or rebase-merge, never
squash (keep Conventional Commit subjects). New required checks worth adding to
branch protection alongside `ci`/`parity`/`evals`: none new (the E2E gate
already exists). Fix debt #1 (worktree pollution) before the first merge.

## New ports / services
llm-gateway :7107, evaluation `serve` :7108, mock ITSM :7303. NATS conf gained
a `llm-gateway` and an `evaluation` user + the auth-callout block — a fresh
`docker compose -p acp-dev up -d` (container recreate) is required after
pulling before E2E.
