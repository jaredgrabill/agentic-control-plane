# Security Self-Assessment

A structured self-assessment in the spirit of the CNCF/OpenSSF security
self-assessment format: system overview, design goals, trust boundaries, a
condensed threat-to-control summary, the honestly-accepted residual risks, and
the assurance activities that tell us the controls work. It is a reviewer's
entry point; the load-bearing detail lives in the
[threat model](threat-model.md), [security architecture](security.md),
[governance & policy](governance-and-policy.md), [multi-tenancy](multi-tenancy.md),
and [knowledge & RAG](knowledge-and-rag.md).

## System Overview

The Agentic Control Plane orchestrates specialized AI agents that call tools
with real-world side effects. It is a control plane: shared services and
protocols (gateway, registry, Cedar policy engine, Temporal orchestrator,
audit trail, knowledge/RAG, token service, tool and LLM gateways) that make
agents both composable and governed.

## Design Goals

1. **The model is never the security boundary.** Every control assumes the LLM
   *can* be fooled and makes a fooled LLM unable to do damage. Defenses are
   **structural invariants** (the attack path does not exist), **enforced
   controls** (a platform component decides per action), and **detective
   layers** (present to shrink what reaches the first two).
2. **Governance is enforced by the platform's boundaries, not by agents.** No
   agent can opt out of policy, audit, budgets, or identity — they are
   properties of the substrate, not library calls an agent chooses to make.
3. **Fail closed on writes, honest on reads.** An action that would mutate a
   system of record without an audit record or a policy allow does not happen;
   partial results are reported as gaps, never silently backfilled.

## Trust Boundaries

Each boundary is stated as its **structural invariant** plus the **enforced
control** that decides per action.

### Governance claims (policy)

- *Invariant:* policy decisions are in code (Cedar), never in prompts. No
  phrasing changes an allow/deny/require-approval outcome. Plans are recorded
  before execution; a replan re-runs policy.
- *Enforced:* the Policy PDP evaluates every governable action, default-deny;
  determining policies and bundle version are captured in the audit record.

### Tenant isolation

- *Invariant:* tenant is token 2 of every NATS subject and is carried on every
  task, step, retrieval, and audit record. There is no cross-tenant subject
  permission, no shared session/memory, and no cross-tenant retrieval path.
- *Enforced:* per-tenant NATS accounts with an auth callout; classification-
  and tenant-scoped retrieval in pgvector; audit and cost keyed by tenant;
  per-tenant budgets and kill-switch tier. Non-platform callers are bound to
  their own tenant on read routes. See [multi-tenancy](multi-tenancy.md).

### Write-path dual controls (R2+)

- *Invariant:* a write-risk (R2+) capability cannot execute on the agent's own
  say-so. Risk class can't be laundered — an R2 tool refuses an R0/R1 context.
- *Enforced:* the R2 approval gate requires a human decision carrying full
  context (plan, diff, blast radius, compensator), a linked change record, and
  eval history; declared compensators unwind completed writes (LIFO) on
  failure, budget exhaustion, or cancellation. See
  [governance & policy](governance-and-policy.md).

### External proxying (A2A edge, tools, LLM)

- *Invariant:* the platform's internal identity and delegated tokens never
  egress. Outbound A2A calls carry the proxy agent's **own** credential, not
  the step's delegated token. The A2A card exported at the edge is a strict
  allowlist projection — internal governance fields (scopes, tool bindings,
  model classes, tenants, compensators, eval baselines) are never present.
- *Enforced:* the tool gateway and LLM gateway are PEPs (Cedar per call,
  schema validation both directions, per-(tool, tenant) rate limits); untrusted
  remote replies are sanitized before re-entry; A2A `input-required` is not an
  approval. See the [threat model](threat-model.md) (ASI02, ASI07).

### Session-cache keying

- *Invariant:* the retrieval session cache is keyed by the caller's
  **permission snapshot** (tenant + classification + source visibility), so a
  cache hit can only ever return what a live authorized query would. The key is
  not attacker-controllable; lineage changes invalidate entries.
- *Enforced:* a key-derivation failure degrades to a live authorized query
  (fail-safe), never a 500 or a stale hit. See
  [knowledge & RAG](knowledge-and-rag.md).

### Identity & delegation

- *Invariant:* per-agent-version identities; agents hold zero tool credentials
  (the gateway brokers per call). No direct agent-to-agent path exists — all
  delegation routes through the orchestrator with schema-validated contracts.
- *Enforced:* RFC 8693 token exchange with scope **intersection** (never
  union), audience binding, TTL ≤ 15 min, and a KV denylist (the kill switch).
  Every hop's `act` chain is in the audit record.

## Threat → Control Summary

The full one-page mapping (OWASP ASI01–10 plus load-bearing LLM Top-10 entries)
with structural invariants, enforced controls, detective layers, and residual
risk per threat is the [threat model](threat-model.md). In brief:

- **Goal hijack / prompt injection (ASI01):** decisions in code, scoped tokens,
  injection classifiers; residual = plausible-but-wrong R0 answers (no write to
  gate).
- **Tool misuse (ASI02):** no path around the tool gateway, one-tool-one-action,
  Cedar per call; residual = misuse within granted scope, bounded by quotas +
  audit.
- **Identity abuse (ASI03):** intersection scopes, short TTL, kill-switch
  denylist; residual = the ≤15-min TTL window.
- **Supply chain (ASI04):** registry-gated signed cards, 2-human review,
  scope-widening flagged; SBOM, pinned deps, Scorecard, secret + code scanning.
- **Poisoning (ASI06):** ingestion is the only corpus write path; lineage
  ledger traces any poisoned chunk to author and every answer it touched.
- **Inter-agent comms (ASI07):** structurally closed (no direct agent-to-agent
  subjects); risk shifts to orchestrator hardening.
- **Rogue agents (ASI10):** registry is the only door; eval-gated promotion,
  kill switch < 10 s, drift demotion.

## Explicitly Accepted Residual Risks

Named so review is a decision, not a discovery (mirrors the threat model):

1. Plausible-but-wrong R0 answers under subtle injection — no write to gate;
   citations, judge sampling, and abstention shrink but don't close it.
2. Judge blind spots — quality gates inherit them; calibration and
   human-override tracking bound the error.
3. Approval fatigue — measured via rubber-stamp metrics; R2-only rationing is
   the structural mitigation.
4. TTL exposure window — ≤ 15 minutes of token validity post-compromise below
   kill-switch severity.
5. Trusted-source poisoning — lineage makes it forensically cheap, not
   impossible.
6. Correlated substrate failure (NATS/Temporal/Postgres) — an availability
   risk mitigated by HA deployment and the [DR runbooks](../runbooks/dr-postgres-backup-restore.md),
   not by agent design.

Anything moving off this list into "solved" requires evidence, not optimism;
anything newly discovered in operation is added here before it is fixed.

## Assurance Activities

- **Red-team suite** — blocking CI gate per agent change + a recurring
  production probe, refreshed quarterly against the current OWASP ASI list.
- **Fault-injection suite** — governance faults (policy denial mid-plan,
  approval timeout, kill switch mid-task) with asserted behavior.
- **Kill-switch drills** — quarterly, per tier, measured against the < 10 s
  propagation SLO ([operational levers](../runbooks/operational-levers.md)).
- **Policy test suite** — golden allow/deny cases in CI; untested policy
  territory fails the build.
- **Judge calibration** — ≥ 85–90% human agreement before any judge gates.
- **Standing governance review** — quarterly per agent (eval trends, incidents,
  approval metrics, cost) with a recorded keep/restrict/retire outcome.
- **Automated hygiene** — OpenSSF Scorecard, `gitleaks` secret scanning,
  `pnpm audit` / `pip-audit` dependency scanning, and CodeQL in CI; progress
  toward the OpenSSF Best Practices badge is tracked in
  [docs/notes/openssf-badge.md](../notes/openssf-badge.md).

## Disclosure

Vulnerability reporting, supported versions, and the coordinated-disclosure
window are in [SECURITY.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/SECURITY.md).
