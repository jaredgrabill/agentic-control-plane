# ADR-0007: The Orchestrator as Identity Broker for Long-Running Tasks

- **Status:** Proposed
- **Date:** 2026-07-11
- **Deciders:** platform architecture group

## Context

[ADR-0004](0004-stateless-jwt-rbac.md) fixes token TTL at ≤ 15 minutes, no
exceptions. Phase 1 forwarded the raw `subject_token` into workflow state and
performed RFC 8693 exchange per delegation — which caps task duration at the
subject token's TTL: once the caller's JWT expires, no further delegation can
be minted from it. Phase 2's plan-then-execute tasks outlive 15 minutes by
design (multi-step plans, approval waits, retries against slow downstreams).

The options:

- **(a) Orchestrator as identity broker.** Verify the subject token ONCE at
  intake, while it is fresh; snapshot the verified claims into durable
  workflow state; mint each step's delegated token at dispatch time from the
  orchestrator's own identity, carrying the snapshotted principal as `sub`
  and the true chain in `act`. Every minted token stays ≤ 15 minutes.
- **(b) Long-lived task token.** Issue the task a token whose TTL covers the
  task's lifetime. Violates ADR-0004 outright.
- **(c) Gateway-side exchange at intake.** The gateway exchanges the caller
  token for an orchestrator-audience token before submission. Still leaves a
  ≤ 15-minute bearer in workflow state — it moves the problem one hop left
  without solving it. A keep-alive variant (periodically re-exchanging from
  inside the workflow) fails on idle workflows (approval waits burn no
  activities to refresh with) and keeps a live user-derived bearer in
  workflow state for the task's whole life.

## Decision

We will make the orchestrator an **identity broker** — option (a):

1. **Principal snapshot at intake.** The workflow's first activity verifies
   the `subject_token` (audience `acp:gateway`) and records a
   `PrincipalSnapshot` — `{sub, tenant, roles, scopes, jti, verified_at}` —
   into workflow state. The raw token is never read again.
2. **Broker grant.** The token service gains
   `POST /v1/token/delegate`: a client holding the new `broker` role asserts
   a subject claim set (the snapshot) instead of presenting a live subject
   token, plus audience, actor, and an explicit scope request (required —
   an empty request grants nothing; scopes never default to the snapshot).
   The minted token has `sub` = the snapshot subject, scopes =
   intersection(requested, snapshot scopes), `act` = the actor→broker
   chain, TTL ≤ 15 minutes.
3. **Per-step minting at dispatch.** Each step's token is minted when the
   step dispatches, not when the task starts — a step running at t+3h
   carries a token as fresh as one minted at t+3s.
4. **Policy evaluates the original principal.** Cedar's `context.scopes`
   come from the snapshot — the principal's actually-held scopes, verified
   at intake.

### Security invariants

- Every token in the system remains ≤ 15 minutes and audience-bound. What
  became durable is the AUTHORITY to re-mint (the snapshot in workflow
  state), never any token.
- Scopes only narrow: brokered ⊆ snapshot ⊆ gateway-verified; agent-facing ⊆
  manifest bindings.
- The `broker` role is granted to exactly one client: `svc:orchestrator`.
- Every mint emits a `token.brokered` audit event carrying the asserted
  subject, audience, scopes, actor, and grounds (`task_id`, intake `jti`,
  `verified_at`) — auditors can join every mint back to its
  `task.submitted`.
- The token service refuses grounds older than
  `ACP_BROKER_MAX_TASK_AGE_SECONDS` (default 86400) — defense-in-depth
  against replaying ancient snapshots.

## Alternatives Considered

- **Long-lived task token (b):** violates ADR-0004's central invariant; a
  captured credential would be worth hours, not minutes. Rejected.
- **Gateway-side exchange at intake (c):** still a ≤ 15-minute bearer in
  workflow state — moves the problem one hop left. The keep-alive variant
  fails on idle workflows (approval waits) and keeps a live user-derived
  bearer in state for the task's lifetime. Rejected.

## Consequences

- **Trust-model change:** the orchestrator asserts a user context it
  verified, rather than proving possession of a user token. Compromise of
  its client credentials allows minting tokens for arbitrary principals
  toward agent audiences. Mitigations: single broker client, audit with
  intake linkage, scope ceilings, and Phase 4 SPIFFE workload attestation
  underneath the client secret.
- **Revocation granularity coarsens** from step to task: an expired subject
  token no longer stops a running task's later steps. The kill switch
  remains the severe-case control. The principal denylist check at broker
  time — deferred at the time of writing — **shipped in Phase 3 item 0c**:
  `TokenIssuer.delegate()`, `exchange()`, and `issue()` now refuse to mint
  for a halted fleet, a suspended agent, or a denylisted principal
  (control-KV key `killswitch.principal.{sub}`, watched in-memory), emitting
  a `token.denied` audit event. A revoked identity therefore gets no fresh
  step token for the task's remaining life; its outstanding tokens live out
  their ≤15-minute TTL while the tool-gateway and NATS-callout checks block
  their use within seconds. Operate it with
  `scripts/kill-switch.mjs deny-principal <principal> --reason "…"`.
- The raw `subject_token` still appears once in workflow history as task
  input; its exposure is bounded by its own ≤ 15-minute TTL.
- Revisit if the IETF on-behalf-of-for-agents drafts standardize a broker
  grant — we would migrate the grant shape, not the architecture.
