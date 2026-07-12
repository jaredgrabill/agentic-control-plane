# Runbook — Tier 1 kill switch (agent)

**Owner:** `<agent-platform-oncall>`  
**Scope:** suspends one agent (by id — all versions). Routers stop dispatching to
it within the < 10 s SLO.

## What it does NOT stop

- **In-flight tasks** are not interrupted by suspension alone. They auto-unwind
  at their next dispatch (discovery of the suspended agent fails → the step
  fails → the saga unwinds), or you cancel them explicitly (below).
- Other agents serving the same capability continue to run. To stop a capability
  everywhere, use [tier 2](kill-switch-tier-2-capability.md).

## Activate

```
node scripts/kill-switch.mjs suspend <agent-id> --reason "<why>"
```

Flips the registry `suspended` state, which writes the control-KV
`killswitch.agent.<id>` flag *before* announcing, and emits
`killswitch.activated{tier: agent}`. The command prints the propagation time vs
the 10 s SLO.

## Verify (< 10 s SLO)

1. The command's printed propagation ms is < 10 000.
2. A new task routed to the agent's capability fails at dispatch with
   `no active agent serves capability …`.
3. Audit: a `killswitch.activated` (tier `agent`, the agent id as target) is on
   the `platform` tenant:
   ```
   GET /v1/events?tenant=platform&event_type=killswitch.activated
   ```

## In-flight handling (exemption matrix)

| Flag | Normal step | Compensator |
|---|---|---|
| agent (tier 1) | blocked | **blocked** (a compensator whose only server is the suspended agent cannot run — honest-incomplete) |

1. Find in-flight tasks touching the agent: `step.dispatched` for the agent with
   no terminal `task.completed`.
2. For each, `POST /v1/tasks/:task_id/cancel` (scope `task:submit`) to force the
   drain-then-unwind, or let auto-unwind fire at the next dispatch.
3. Verify each task's terminal `compensation.completed`. A
   `compensation.status: incomplete` means a write remains in effect — if the
   suspended agent was the only server of the compensator, compensate manually
   per the capability's runbook and record it.

## Reinstate / rollback

```
node scripts/kill-switch.mjs reinstate <agent-id> --reason "<why>"
```

Sends the agent back through the lifecycle (`suspended → active` legacy edge) and
emits `killswitch.cleared`.

## Quarterly drill

- Staging first. Suspend a canary agent, time the propagation, confirm a routed
  task fails, then reinstate and confirm recovery.
- Record on the timed sheet: flip time, observed enforcement time, delta vs SLO.
- **Post-drill checklist:** agent active again; a fresh task completes;
  `GET /v1/verify?tenant=platform` still passes; the drill's own
  `killswitch.activated`/`cleared` pair is on the ledger.
