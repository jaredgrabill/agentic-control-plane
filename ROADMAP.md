# Roadmap

Vision → shippable increments. Each phase ends with something **running,
demoable, and governed** — governance capabilities ship *with* the features
they govern, never "later." Phases are scope-sequenced, not date-promised;
sizes assume a small platform team (3–6 engineers) and are given in relative
terms.

```
Phase 0        Phase 1           Phase 2            Phase 3             Phase 4
Foundations →  Walking         → Composition      → Write actions     → Scale &
(~4 wks)       skeleton          & evaluation       & hard governance    ecosystem 1.0
               (~8 wks)          (~8 wks)           (~8 wks)            (~10 wks)
```

## Phase 0 — Foundations

*Goal: a contributor can clone, `make dev`, and see the substrate run.*

- Monorepo scaffold per [coding-standards](docs/standards/coding-standards.md):
  pnpm+Turborepo, uv workspace, `packages/protocol` with the first schemas
  (manifest, task contract, audit event), generated TS + Pydantic bindings.
- CI skeleton: lint/type/test both languages, commitlint, release-please,
  OpenSSF Scorecard, docs build (mkdocs-material).
- Dev stack: docker-compose with NATS (accounts + auth-callout stub),
  Temporal, Postgres+pgvector, OTel collector; `fixtures/acme-corp`
  synthetic enterprise dataset v0.
- **Exit:** green CI on a PR that changes a protocol schema and regenerates
  both bindings; dev stack up in one command.

## Phase 1 — Walking Skeleton (one agent, fully governed)

*Goal: one R0 agent answers one question end-to-end with every governance
boundary real — thin, but nothing mocked in the control path.*

- **Token Service** (JWT issuance, RFC 8693 exchange, JWKS) + Gateway v0
  (authN, attribution stamping, task submission).
- **Agent Registry v0:** manifest validation, signed cards, lifecycle states
  (registered/active/suspended only), NATS announcements, KV cache.
- **Orchestrator v0:** `TaskWorkflow` + `AgentStepWorkflow` (single-step
  tasks), TS workflows + Python activity workers proving the polyglot split.
- **Policy Service v0:** Cedar PDP, default deny, allow/deny only; policy
  bundles from git with test suite.
- **Python SDK alpha** + `acp-create-agent`; telemetry (`gen_ai.*` + `acp.*`
  spans), structured logging, FakeModel test seam.
- **Knowledge Service v0:** ingestion workflow, hybrid search, citations,
  and the **corpus lineage ledger** from day one (`lineage_id` on every
  chunk, corpus-mutation audit events) — cheap now, painful to retrofit.
- **Knowledge & Policy agent v0** (R0): `knowledge.search`,
  `knowledge.answer_with_citations` with golden set + citation-precision
  evals in CI (gates 1–2).
- **Audit v0:** JetStream audit stream (deny-delete) → append-only
  Postgres, delegation chain from `act` claims in every record; corpus
  lineage events on the same stream. (WORM tiering lands in Phase 3.)
- Kill switch tier 1 (suspend agent, <10s propagation) — day one, not later.
- **Exit scenario:** "What does our policy say about change freezes?" →
  cited answer; trace shows gateway→workflow→agent→retrieval; audit shows
  the full delegation chain; suspending the agent stops traffic in seconds.

## Phase 2 — Composition & Evaluation

*Goal: multi-agent answers with the trust machinery measuring quality
continuously.*

- **TypeScript SDK alpha** + `create @acp/agent` (parity gate with Python).
- **Cloud agent v0** (TS) and **Source Code agent v0** (TS): R0 capabilities.
- Orchestrator v1: plan-then-execute, parallel fan-out, partial-results
  semantics, delegation depth caps, per-task budgets.
- Discovery v1: structured capability matching + semantic ranking.
- **Evaluation Service v0:** golden-set runner in CI, calibrated judge
  harness, baselines in registry, red-team suite as blocking gate (gate 3).
- **Cost Meter v0:** span pricing, price book, per-task/agent/tenant
  showback dashboards; task-level budget enforcement.
- LLM gateway v1: model classes, prompt-caching layout enforcement,
  provider failover, batch routing for ingestion/evals.
- Tool gateway v1: MCP tool servers behind policy + credential brokering;
  first two real tool servers (Git forge, cloud read APIs) + mock servers
  for the rest.
- **Knowledge Service as MCP tool server:** the governed corpus exposed via
  standard MCP through the tool gateway — developer CLIs/IDE agents become
  first-class consumers.
- Ingestion v1: event-driven triggers from git/CI/ticket webhooks + the
  per-source reconciliation sweep (freshness SLO measured, not assumed).
- **Exit scenario:** cost-spike forensics ("why did spend jump?") composes
  Cloud + Source Code + Knowledge agents; eval dashboards show per-agent
  quality; a deliberately-regressed prompt PR is blocked by the eval gate.

## Phase 3 — Write Actions & Hard Governance

*Goal: the platform earns the right to change things.*

- **Deployment Controller:** full lifecycle — shadow mode (side-effect
  suppression at the tool gateway), canary with session pinning, auto-ramp
  gates, auto-rollback, demotion (gates 4–5).
- **Approval machinery:** `require-approval` Cedar decisions,
  `ApprovalWorkflow` with escalation/timeout-deny, approval UX with full
  context (plan, diff, blast radius, compensator), rubber-stamp metrics.
- **Compensation:** saga stacks; compensator declarations enforced at
  registration.
- **Change/ITSM agent v0** with `change.draft` (R1) and `change.submit`
  (R2) — the first gated write; **Cloud `cloud.tag_apply`** (R2) as the
  low-blast-radius write proving the machinery.
- Kill switch tiers 2–3 (capability, fleet) + quarterly drill runbooks.
- Audit v1: hash-chaining, replayability (reconstruct any task), retention
  tiers.
- Online evaluation: sampled judge scoring, synthetic probes, drift
  detection (joint-condition alerting), quality error budgets wired to
  change freezes.
- Security hardening: SPIFFE/mTLS profile, injection classifier layers,
  egress-allowlisted sandbox pattern for code-executing capabilities.
- **Exit scenario:** acceptance scenario 4 (**governed patch rollout**,
  [domains.md](docs/domains.md)) passes end-to-end — gated ITSM write,
  human approval from Slack/ITSM, gated cloud write, and the
  injected-failure path unwinding compensation honestly; plus a
  shadow-deployed Knowledge agent v2 promotes to active through gates with
  zero manual routing steps, and a failed canary auto-rolls back.

## Phase 4 — Scale, Ecosystem, 1.0

*Goal: other teams build agents without us; the project stands as public
infrastructure.*

- **NetSec agent v0** (highest-consequence domain last, R0/R1 only at GA;
  `netsec.rule_apply` ships behind dual controls when eval history justifies).
- All five acceptance scenarios as standing E2E evals in nightly CI.
- Paved-road SLO measured: external pilot team scaffold→shadow < 1 week.
- Multi-tenancy GA: NATS account automation, tenant onboarding, per-tenant
  budgets/chargeback export.
- A2A edge: card export, external agent proxying; MCP registry-format
  publication of tool servers.
- **Session Context Cache** (NATS KV, permission-snapshot keyed,
  lineage-invalidated) — the retrieval hot path, added once real usage
  patterns justify and measure it.
- Operability: helm charts, upgrade/DR runbooks, load/soak tests, SLO
  dashboards out of the box.
- OSS 1.0: versioned docs site, OpenSSF Best Practices badge (passing),
  security self-assessment, contributor onboarding guide, public roadmap +
  RFC process; protocol/SDK API freeze under SemVer.
- **Exit:** 1.0 tag — a team outside the founding org has shipped an agent
  to active through the full lifecycle.

## Sequencing Principles

1. **Governance ships with capability.** Audit and kill switch land with the
   first agent (Phase 1), approval gates land with the first write (Phase 3)
   — the platform is never temporarily ungoverned.
2. **One real thing before many.** One agent end-to-end (P1) before three
   (P2) before five (P4); one R2 capability proves the machinery before the
   scary domain gets one.
3. **Evals before writes.** The trust machinery (P2) precedes write actions
   (P3) because promotion gates are what make writes defensible.
4. **Both SDKs stay honest** by shipping reference agents in each language
   from Phase 2 on.

## Post-1.0 Candidates (explicitly deferred)

R3 (auto-write) enablement framework · agent memory with governance ·
cross-org A2A federation · OASF export · semantic caching GA · pgvectorscale
tier · marketplace/catalog UX · additional domain packs (HR, finance, data
platform).
