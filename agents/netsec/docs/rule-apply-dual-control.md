# Design: `netsec.rule_apply` (R2) behind dual controls — DEFERRED

Status: **design only**. v0 of the netsec agent ships R0 reads plus a
side-effect-free R1 draft and **zero write surface**: no `rule_apply`
capability, no write tool on the mock, no permit/gate policy pair, no netsec
store. This document is the design that a follow-on phase implements; nothing
in it is built today.

## Why v0 stops at R0/R1

`domains.md` (network security) forbids single-control firewall mutation:
production rule changes run **only behind dual controls — policy engine +
human approval + linked change record**. Today's R2 machinery provides
exactly ONE of those controls end to end; the second (a linked *approved
change record*) is a **net-new platform primitive**, not a configuration of
what exists. Shipping `rule_apply` before that primitive exists would put a
single-control write on the highest-consequence domain in the platform.

## Control #1 — approval + reversibility (free with today's machinery)

Declaring `netsec.rule_apply` as R2 with a same-manifest compensator
`netsec.rule_revert` (registration Rules 3/5) inherits the existing gates:

- `gate-r2-delegation.cedar` (`@decision("require-approval")` on R2 without a
  compensation context) suspends the task on a human approval, exactly as
  `change.submit` does.
- A new mutually-exclusive tool pair, mirroring
  `permit`/`gate-tool-itsm-change-submit`:
  `permit-tool-netsec-rule-apply.cedar` permits only when
  `context.approval.granted == true && context.approval.capability ==
  "netsec.rule_apply"`; `gate-tool-netsec-rule-apply.cedar` matches the
  negation under `@decision("require-approval")`.
- A real `NetsecStore` mirroring `ItsmStore` (idempotency ledger, `dry_run`,
  a rule state machine) so the write is reversible: `netsec.rule_revert`
  (R2, or R1 per Rule 5) is the declared compensator, and
  `permit-compensation.cedar` carries the LIFO saga unwind exactly as it does
  for `change.withdraw`.

That is one control: an approved, reversible write. The domain requires two.

## Control #2 — a signed, task-bound change-record claim (NET-NEW)

**Trust boundary:** the tool gateway PEP deciding
`tool:netsec:rule_apply`.
**Attacker-controllable:** the capability input — the proposed rule and any
`change_id` the agent puts in its own arguments. An agent (or a
prompt-injected plan) could fabricate a plausible `CHG-` id; input is never
evidence.
**Broker-verified (not forgeable):** claims the broker mints into the
exchanged token, correlation-bound to the task/step — the same invariant
`deriveApproval` enforces today (Phase 3).

Today the gateway derives Cedar context ONLY from verified token claims:
`scopes`, `tenant`, `approval`, `capability`, `compensation`
(`apps/tool-gateway/src/core.ts`, deriveCapability/Compensation/Approval).
`context.change_record` does not exist, and cross-agent linkage does not
exist (registration Rule 3 forbids cross-agent compensators; the
governed-writes E2E runs change-agent and cloud-agent writes independently).

The primitive, in three steps:

1. **Source.** The plan first runs the change agent:
   `change.draft → (approval) → change.submit`, yielding an approved `CHG-`
   id in the ITSM system of record. The orchestrator planner sequences
   `change.draft → approve → change.submit → netsec.rule_apply`.
2. **Mint & bind (broker).** When dispatching the `rule_apply` step, the
   broker derives a `change_record` claim `{change_id, approved: true}` from
   the RECORDED OUTPUT of the preceding `change.submit` step and binds it to
   THIS task (the same `brokered.task_id` correlation as `deriveApproval`).
   Derive-and-bind from verified prior-step output — never from agent input.
   Gateway side: add `deriveChangeRecord(claims, corr)` to `core.ts`,
   returning `{linked: false}` unless the claim is present AND task-bound.
   **Content binding (not just task binding).** Task-correlation alone proves
   only that *some* approved change record exists in this task — a plan holding
   an approved `CHG-` for change X plus a `rule_apply` for an unrelated rule Y
   in the same task would satisfy a task-bound conjunction. The broker MUST
   therefore also verify the `change.submit` payload references the same
   service/rule being applied (e.g. `change_record.subject` covers the
   `rule_apply` input's service + rule), so the approved record authorizes
   *this specific* mutation, not merely *a* mutation somewhere in the task.
3. **Consume (Cedar pair).** `permit-tool-netsec-rule-apply` requires BOTH
   grounds conjunctively:
   `context.approval.granted && context.approval.capability ==
   "netsec.rule_apply"` AND `context.change_record.linked == true &&
   context.change_record.approved == true` (optionally also
   `context.window.business_hours`, per the governance sketch in
   `governance-and-policy.md`). The gate half negates the whole conjunction,
   so a missing either-half lifts to require-approval, never silently allows.

## Why one approval is not enough

An approval proves a human clicked "approve" **for this step**. It does not
prove the firewall change is anchored to a governed, auditable change record
in the system of record. Requiring the linked-change-record claim closes two
paths at once:

- **Social-engineered approver, no ITSM change:** an approver waved through a
  step, but no governed change exists — the conjunction fails on
  `change_record.linked`.
- **Agent-fabricated change id:** the agent passes `change_id` in its own
  input — rejected by construction, because the claim is broker-minted from
  the prior step's recorded output, never read from agent input.

## Why deferred (what must be built first)

1. A new derived Cedar context source + claim type in the tool gateway
   (`change_record`, minted at the broker, correlation-bound).
2. Orchestrator planner/`workflows.ts` cross-agent step linkage: minting a
   claim for one agent's step from a DIFFERENT agent's recorded prior-step
   output — a linkage the platform deliberately does not have today.
3. `NetsecStore` + the `rule_revert` compensator saga (mirror of `ItsmStore`).

Until all three exist, `netsec.rule_apply` stays out of the manifest, out of
the mock, and out of the policy bundle — and
`policies/tests/cases.json` pins `tool:netsec:rule_apply` to default-deny
even with a granted approval, so the absent write door is a tested invariant,
not an accident.
