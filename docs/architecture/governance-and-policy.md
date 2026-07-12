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

**Approval machinery v1 (as-built, Phase 3 item 1).** Cedar stays two-verdict
in-engine; a `@decision("require-approval")` annotation on a **permit** lifts
the allow it determines into a three-way `require-approval` (`apps/policy`).
The lift is restrictive: if any policy determining an allow is annotated, the
decision is require-approval — a later broad plain permit can only over-gate,
never bypass. `gate-r2-delegation.cedar` gates R2 user→agent delegation. Two
PEPs consume the three-way, with different verbs:

- The **orchestrator delegation PEP is the suspending gate.** On
  require-approval, `AgentStepWorkflow` builds an `ApprovalSubject` (plan, exact
  step input, capability + risk, agent@version, scopes, compensator or
  `irreversible`), digests it (`subject_digest = sha256(stableStringify(subject))`,
  computed in an activity), and launches an `ApprovalWorkflow` child that waits
  durably on a signal. It escalates (notification only) at `T1 = 3600s` and
  **DENIES by default** at `T2 = 86400s` — no path grants without an accepted
  signal. First valid decision wins; already-decided, bad-value, empty-approver,
  self-approval (`approver === subject.principal`), and digest-mismatch signals
  are rejected and counted (rubber-stamp/tampering signal). On grant the
  orchestrator re-discovers the agent (suspension during the wait still stops
  traffic) and brokers the step token WITH a signed `approval` claim.
- The **tool gateway is a verify-only PEP: it refuses, never suspends.** It
  derives `context.approval` from VERIFIED token claims only, granted iff the
  approval claim binds to the exact call (`brokered.task_id === corr.taskId &&
  corr.stepId === approval.step_id`); a require-approval verdict is refused
  (`upstream_auth`, audited). v1 binds approval at STEP granularity
  (tool-call-level divergence is item-3 risk-class territory).

The approver decides via the gateway approval API (`GET /v1/approvals/:id`,
`POST /:id/decision`, scope `approvals:decide`) or `scripts/approve.mjs`
(show-first, so deciding blind is structurally impossible). The approver
identity is the verified JWT `sub`, never the body; separation of duties (403),
stale digest (409), already-decided (409), and cross-tenant (404) are enforced
at the gateway AND re-validated inside the workflow. The signed `approval`
claim IS "the approval token returning through the platform, signed and
audited"; it propagates verbatim across the agent's same-actor `acp:tools`
exchange so the tool gateway can bind it. Five audit events —
`approval.requested/granted/denied/timeout/escalated` — carry the full subject
context, the approver, and `rubber_stamp = latency_ms < 1000`. Slack/ITSM
surfaces and per-task timeout overrides remain future work.

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
