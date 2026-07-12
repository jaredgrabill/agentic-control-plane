# Runbook — Tier 2 kill switch (capability & risk class)

**Owner:** `<governance-oncall>`  
**Scope:** platform-wide, agent-agnostic. Two families:

- **Named capability** — `killswitch.capability.<name>` blocks one capability
  (e.g. `change.submit`) everywhere, at every PEP.
- **Risk class** — `killswitch.risk.<class>` blocks a whole class. **Monotonic:**
  a flag on class C blocks every executing risk with rank ≥ rank(C), so
  `killswitch.risk.R2` blocks R2 and R3 but not R1. R0 is not flaggable — halt
  the [fleet](kill-switch-tier-3-fleet.md) instead.

## What it does NOT stop

- R0 reads under a risk flag (unless a lower class is flagged). A named-capability
  flag stops only that capability.
- **A bound compensator** under a *risk* or *fleet* flag — it is exempt (see the
  matrix). A named-capability flag DOES stop even a compensator.

## Activate

```
# named capability
node scripts/kill-switch.mjs suspend-capability change.submit --reason "<why>"
# risk class (R1 | R2 | R3)
node scripts/kill-switch.mjs suspend-risk R2 --reason "<why>"
```

Both call the registry's audited routes
(`POST /v1/killswitch/{capability/:name,risk/:class}`, scope `registry:admin`),
which flip the control KV *before* emitting `killswitch.activated{tier, target}`.
The command prints propagation ms vs the 10 s SLO.

## Verify (< 10 s SLO)

1. Printed propagation ms < 10 000.
2. A task exercising the capability/class fails its step closed with
   `… halted by kill switch (tier <t>: <target>) … — step not executed`, and
   **no** `approval.requested` is emitted (fail-closed before the gate).
3. A direct R2 tool call is refused at the tool gateway with a `tool.called`
   audit carrying `details.refusal = "killswitch"`.
4. Audit: `GET /v1/events?tenant=platform&event_type=killswitch.activated`.

## In-flight handling — the compensation-exemption matrix

| Flag | Normal step | Compensator |
|---|---|---|
| named capability | blocked | **blocked** (surgical intent wins) |
| risk class (rank ≥ flag) | blocked | **EXEMPT** |
| fleet | blocked | **EXEMPT** |
| agent (tier 1) | blocked | blocked |

**Why compensators are exempt from risk/fleet:** the platform must unwind
in-flight writes on a halt. Without the exemption a risk/fleet halt would leave
every in-flight R2 write permanently un-compensable — the kill switch would
*preserve* the danger it was pulled to remove. The exemption is enforced
identically at all PEPs (orchestrator pre-dispatch, token `delegate()`, tool
gateway); the compensation grounds are broker-minted from the unwind loop and
correlation-bound, so an agent cannot self-assert them.

1. A risk-R2 halt while a write task is mid-flight: the write's dependent step
   fails → the saga unwinds → the R2 compensator runs *under the active flag*
   (exempt) → `compensation.completed{status: complete}`.
2. Find incomplete unwinds:
   `GET /v1/events?tenant=<t>&event_type=compensation.completed` →
   `status: incomplete`, then compensate manually per the capability runbook.

## Reinstate / rollback

```
node scripts/kill-switch.mjs reinstate-capability change.submit --reason "<why>"
node scripts/kill-switch.mjs reinstate-risk R2 --reason "<why>"
```

Emits `killswitch.cleared`; the governed flow resumes at the next dispatch.

## Quarterly drill

- Staging first. Suspend a test capability (or R2), submit a governed write,
  confirm the fail-closed gap + no approval, confirm a compensator still unwinds
  an already-completed write, then reinstate.
- Record on the timed sheet: flip time, observed enforcement time, delta vs SLO.
- **Post-drill checklist:** flag cleared; a governed write completes end to end;
  `GET /v1/verify?tenant=<t>` and `?tenant=platform` pass; the drill's
  `killswitch.activated`/`cleared` pair is on the ledger.
