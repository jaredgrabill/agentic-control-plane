# Threat Model

One-page mapping from threat to control to **residual risk** — the summary a
security reviewer reads first. Taxonomy: OWASP Top 10 for Agentic
Applications 2026 (ASI01–10), with load-bearing entries from the OWASP LLM
Top 10 2025 and MITRE ATLAS agent techniques. Detailed designs live in
[security.md](security.md), [governance-and-policy.md](governance-and-policy.md),
[evaluation.md](evaluation.md), and [knowledge-and-rag.md](knowledge-and-rag.md).

**Stance:** the model is never the security boundary. Every control below
assumes the LLM *can* be fooled and makes a fooled LLM unable to do damage.
Defenses divide into **structural invariants** (the attack path does not
exist), **enforced controls** (a platform component decides per action), and
**detective layers** (imperfect by design, present to shrink what reaches
the first two).

## Threat → Control Map

| # | Threat | Structural invariants | Enforced controls | Detective layers | Residual risk |
|---|---|---|---|---|---|
| ASI01 | **Agent goal hijack** (incl. LLM01 prompt injection) | Policy decisions in code, never in prompts — no phrasing changes a Cedar decision; plan recorded before execution, replans re-run policy | Scoped tokens (intersection, ≤15 min); step/token/depth caps | Injection classifiers at gateway + ingestion; trust-tier delimiting; red-team CI gate | Subtle injection shaping *plausible-but-wrong R0 answers* — no write to gate. Mitigated by citations, judge sampling, abstention; not eliminated |
| ASI02 | **Tool misuse** | No path around the tool gateway; one-tool-one-action (no free-form shells); risk class can't be laundered (R2 tool refuses R0/R1 context) | Cedar PDP per call, default deny; schema validation both directions; per-tool scopes; rate limits per (tool, tenant) | Tool-output screening for embedded instructions; usage-pattern anomaly alerts | Misuse *within* granted scope (a permitted query used for harm) — bounded by quotas and audit, not prevented |
| ASI03 | **Identity & privilege abuse** | Per-agent-version identities; agents hold zero tool credentials (gateway brokers per call) | RFC 8693 exchange, scope **intersection** never union; TTL ≤ 15 min; audience binding; denylist via KV (kill switch) | Delegation chains (`act` claims) in every audit record | TTL window (≤15 min) of validity after a compromise below kill-switch severity |
| ASI04 | **Supply chain** (agents, tools, deps) | Agents/tools enter only via registry: signed cards, 2-human review; new agents earn traffic through shadow/canary | Scope-widening diffs flagged as privilege-escalation review, no self-approval | SBOM, pinned deps, OpenSSF Scorecard, secret scanning, CodeQL in CI | Compromise of an *approved* upstream dependency between reviews — window bounded by scanner cadence |
| ASI05 | **Unexpected code execution** | Execution tools run inside microVM/gVisor sandboxes, **outbound-only** (no inbound sockets, egress = NATS subjects only), per-task disposable | Sandbox capability requires elevated review; results return schema-validated via gateway | Sandbox telemetry; egress-attempt alerts | Sandbox-escape 0-days (microVM boundary is strong, not metaphysical) |
| ASI06 | **Memory & context poisoning** | Ingestion is the only write path to the corpus (registered connectors, owner sign-off); no cross-tenant/session memory; session cache is permission-snapshot keyed | Classification-aware retrieval in the query, not the prompt; trust labels on every chunk | Injection screening at ingestion; lineage ledger traces any poisoned chunk to author + every answer it influenced | Poisoning via a *trusted* source (compromised wiki account) — detected by lineage forensics after the fact, not prevented |
| ASI07 | **Insecure inter-agent comms** | No direct agent-to-agent paths exist (no NATS subject permissions for it); all delegation via orchestrator with schema-validated contracts | Authenticated bus (accounts, auth callout); scoped tokens per delegation | Full hop-by-hop tracing | Effectively closed structurally; risk shifts to orchestrator compromise (control-plane hardening) |
| ASI08 | **Cascading failures** | Task queues isolate downstreams; budgets/caps are workflow state, not agent self-discipline | Circuit breakers on tool servers; per-session quotas; compensation stacks unwind partial work | Queue-depth and tool-error alerting; honest partial-result reporting | Correlated failure of shared substrate (NATS/Temporal/Postgres) — an availability risk, mitigated by HA deployment, not by agent design |
| ASI09 | **Human-trust exploitation** | — | Citations mandatory for factual claims; AI-interaction disclosure on by default (EU AI Act Art. 50); approvals carry full context (plan, diff, blast radius, compensator) | Rubber-stamp metrics (sub-second approvals flagged); abstention gated in evals | Users trusting fluent, cited, *wrong* answers; approval fatigue eroding the R2 gate — measured (override rates, stamp rate), managed, not solved |
| ASI10 | **Rogue agents** | Registry is the only door; agents can't mutate own manifest/policy; can't act without audit (fail-closed for writes) | Lifecycle governance: TTL heartbeats, eval-gated promotion, kill switch < 10 s, drift demotion | Synthetic probes; quarterly governance review per agent | "Rogue" via slow behavioral drift below alert thresholds — bounded by probe sensitivity |
| LLM05 | **Improper output handling** | Agent output is untrusted input to whatever consumes it — schemas everywhere, no string-interpolated execution | Structured-repair-once-then-fail (never best-effort parse); secret/PII egress scanning | Output guardrail classifiers | Downstream consumers *outside* the platform mishandling exported artifacts |
| LLM10 | **Unbounded consumption** | Budgets are workflow state; hierarchical caps (org→tenant→team→agent→task) | Hard caps → structured 429s; rate limits per queue | Cost-anomaly alerts (deviation pages before the invoice) | Spend *within* budget on worthless work — a quality problem, caught by evals not budgets |

## Drift (the slow failure)

Drift is an operational certainty — providers silently update models,
corpora rot, tool APIs shift — so it gets a standing control loop rather
than an incident response:

| Vector | Detection | Automatic response |
|---|---|---|
| Provider model drift (your prompts didn't change; the model did) | Continuous synthetic probes (known-answer prompts) against every active agent | Routing-weight demotion → suspend at SLO floor |
| Behavioral drift (tool-selection patterns shift) | Per-capability tool-usage monitoring | Owner alert; joins quality SLI |
| Semantic drift (outputs move) | Query/response embeddings + judge scores per sampled trace; alert on **joint** condition (input drift *and* score drop) | Quality error budget burns → change freeze |
| Corpus rot | Staleness SLOs per source; reconciliation sweep diffs | Ingestion alerts; effective dates surfaced in answers |
| Tool contract drift | Nightly contract tests against sandboxes; registry knows every agent bound to a changed tool | Affected-agent eval runs before tool promotion |
| Self-inflicted drift (your own changes) | Gates 2–5: offline evals → shadow → canary, relative to stored baselines | Auto-rollback; two rollbacks → demote to shadow |

Escalation is graduated and automatic: alert → error-budget burn/change
freeze → routing demotion → auto-suspend and page. A drifting agent loses
traffic without waiting for a human to notice.

## Assurance Activities (how we know the controls work)

- **Red-team suite** — blocking CI gate per agent change + recurring
  production probe; refreshed quarterly against the current OWASP ASI list.
- **Fault-injection suite** — governance faults included (policy denial
  mid-plan, approval timeout, kill switch mid-task) with asserted behavior
  ([testing.md](../standards/testing.md)).
- **Kill-switch drills** — quarterly, per tier, measured against the < 10 s
  propagation SLO.
- **Policy test suite** — golden allow/deny cases in CI; untested policy
  territory fails the build.
- **Judge calibration** — ≥ 85–90% human agreement before any judge gates;
  recalibrated on judge-model changes.
- **Standing governance review** — quarterly per agent: eval trends,
  incidents, approval metrics, cost; outcome recorded
  (keep / restrict / retire).

## Explicitly Accepted Risks

Named so review is a decision, not a discovery:

1. **Plausible-but-wrong R0 answers under subtle injection** — no write to
   gate; citations, sampling, and abstention shrink but don't close it.
2. **Judge blind spots** — quality gates inherit them; calibration and
   human-override tracking bound the error.
3. **Approval fatigue** — measured via rubber-stamp metrics; rationing (R2
   only) is the structural mitigation.
4. **TTL exposure window** — ≤ 15 minutes of token validity post-compromise
   below kill-switch severity.
5. **Trusted-source poisoning** — lineage ledger makes it forensically
   cheap, not impossible.

Anything moving from this list into "solved" territory requires evidence,
not optimism — and anything new discovered in operation gets added here
before it gets fixed, so the list stays honest.
