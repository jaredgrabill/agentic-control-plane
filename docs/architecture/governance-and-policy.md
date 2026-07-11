# Governance and Policy

Governance here means **continuous, runtime enforcement** — not a launch
checklist. Three mechanisms: the policy engine (every action), the audit
trail (every decision), and the lifecycle machinery (every version —
covered in [agent-lifecycle.md](agent-lifecycle.md)).

## Policy Engine

**Cedar** as the policy decision point ([research basis](../research/governance-safety-security.md)):
formally analyzable, default-deny, forbid-overrides-permit — the right
properties for authorization the model must not be able to talk around.

**Every governable action gets a decision:**

- tool calls (the tool gateway is the PEP),
- agent-to-agent delegations (the orchestrator is the PEP),
- capability risk escalations (R1+),
- knowledge retrievals crossing classification boundaries,
- budget-relevant actions when a principal is near cap.

**Decisions are three-way:** `allow` | `deny` | `require-approval`.
`require-approval` suspends the Temporal workflow on an `ApprovalWorkflow`
gate — the mechanism that makes R2 capabilities safe to ship.

**Policy structure.** Policies are code: versioned in git, reviewed like
code (2 approvals — policy changes are the most privileged change type in
the platform), tested like code (a policy test suite with golden
allow/deny cases runs in CI; a policy change that flips untested territory
fails the build). The PDP loads signed policy bundles; active bundle version
is stamped into every audit record.

```cedar
// Sketch: R2 firewall writes require an approved change record and on-hours window
permit (
  principal in Role::"agent",
  action == Action::"tool:firewall-mgr:rules:write",
  resource
) when {
  principal.has_capability("netsec.rule_apply") &&
  context.change_record.approved == true &&
  context.window.business_hours == true
};
// default deny covers everything else
```

**Approval design (HITL fatigue is a threat, not a virtue).** Approvals are
rationed to genuinely consequential actions: R2 by default, R1 never, R0
never. Approval requests carry the full context (plan, diff, blast radius,
compensator) so approving is a decision, not a rubber stamp. Delivery
happens where approvers already live — Slack/Teams interactive cards, ITSM
approval tasks, and the platform console are all fronts on the same
`ApprovalWorkflow`; the workflow waits durably (hours or days at zero
compute) and the approval token returns through the platform, signed and
audited, whichever surface it came from. Note the enforcement direction:
approval gates are triggered by the **policy engine at the tool gateway**,
never by agents electing to ask — an agent cannot skip a gate it never
controls. Metrics track
approval latency and rubber-stamp rate (sub-second approvals get flagged);
repeated 100%-approval capabilities become candidates for R3 *by explicit
governance decision*, never by drift.

## Risk Classes Drive Everything

| | R0 read | R1 draft | R2 write-gated | R3 write-auto |
|---|---|---|---|---|
| Policy decision | allow (logged) | allow (logged) | require-approval | allow (logged) |
| Compensator required | – | – | yes (or `irreversible` flag → stricter approval) | yes |
| Promotion gate extra | – | – | owner sign-off + game-day tested rollback | standing governance review + eval history threshold |
| Default state | enabled | enabled | enabled per-capability | **disabled platform-wide**; enabled per-capability by steering decision |

## Audit Trail

**Every hop, append-only, provenance-rich.** Audit events flow onto the
JetStream audit stream (deny-delete/deny-purge, file-backed, replicated)
and are consumed into partitioned, hash-chained Postgres tables, with an
object-lock/WORM storage tier for regulated deployments (7+ year retention
where mandated). Two ledgers share this pipeline: **agent actions** (below)
and **corpus mutations** — every vector write, chunking-strategy change,
and embedding-model version, keyed by `lineage_id`
([knowledge-and-rag.md](knowledge-and-rag.md)). Retrieval events record the
`lineage_id`s they served, so "what exactly did the agent read at that
second" is a join, not an investigation.

Each record carries:

- **Who:** full delegation chain from token `act` claims (user → orchestrator
  → agent version → tool).
- **What:** action, inputs digest, outputs digest, side effects.
- **Why:** task ID, plan step, the policy bundle version and the specific
  policy decision (including *which* policy matched).
- **With what:** model + version, prompt template version, retrieval set
  (chunk IDs + versions), agent version, workflow run ID.

**Replayability.** Because every input artifact is versioned (prompts,
policies, knowledge chunks, manifests), any past task can be reconstructed
step-by-step with the artifacts in force at the time. Replay is an
Evaluation Service feature (re-run a task against a new agent version) and a
compliance feature (show the examiner exactly what happened) with one
implementation.

**Integrity.** Hash-chaining detects tampering; audit-write failure is a
platform incident (agents don't proceed silently when audit is down —
configurable fail-closed for R1+, fail-open-with-alarm for R0).
Retention defaults: 6 months hot (EU AI Act Art. 19 floor), archival tier
per deployment policy.

## Governance Operations

- **Agent inventory as an asset register:** the Registry answers "what
  agents exist, what can they do, who owns them, what's their eval history"
  — the anti-shadow-AI control.
- **Standing review:** quarterly governance review per active agent: eval
  trends, incident history, approval metrics, cost trajectory. Output is a
  keep / restrict / retire decision, recorded.
- **Change advisory integration:** R2 capability enablement and policy
  bundle changes ride the organization's own change process (the ITSM
  agent's domain — the platform eats its own dog food).
- **Kill-switch drills** quarterly, per tier, with measured
  time-to-suspension (an SLO: agent suspension propagates in < 10 s).

## What Agents Can Never Do

Hard platform invariants, enforced structurally (not by policy that could be
misconfigured):

1. Call a tool without a policy decision (no bus path exists around the tool
   gateway).
2. Hold long-lived or system-of-record credentials.
3. Message another agent directly (no subject permissions exist for it).
4. Mutate their own registry record, manifest, or policy.
5. Act without an audit record (fail-closed for writes).
