# Runbook — Tier 3 kill switch (fleet)

**Owner:** `<incident-commander>`  
**Scope:** the emergency stop. Halts **all** task intake and dispatch, and
auto-cancels every in-flight `TaskWorkflow`.

## What it does NOT stop

- **DeploymentWorkflows are NOT cancelled.** Killing a controlled rollout loses
  ramp state; abort deployments manually (`POST /v1/deployments/:agent_id/abort`)
  if the incident requires it. Note: a deployment's soak timers keep running
  against a halted fleet — its gates will read a starved window; abort it.
- Control-plane service tokens (the fleet halt does not stop the platform
  issuing its own `client_credentials`), and **bound compensators** (exempt, so
  the auto-cancelled tasks can actually unwind).

## Activate

```
node scripts/kill-switch.mjs halt-fleet --reason "<why>"
```

Calls `POST /v1/killswitch/fleet` (scope `registry:admin`), which flips
`killswitch.fleet` in the control KV *before* emitting
`killswitch.activated{tier: fleet}`. Within seconds:

- The **gateway refuses intake** with `503` (`task intake halted by fleet kill
  switch`).
- The **fleet auto-canceller** (gateway) sweeps RUNNING `TaskWorkflow`s and, for
  each, emits `task.cancel_requested{trigger: fleet_killswitch}` then requests
  cancellation. It re-sweeps every 15 s while the halt is active (catching the
  intake/flip race and surviving a gateway restart).

## Verify (< 10 s SLO)

1. Printed propagation ms < 10 000.
2. A new `POST /v1/tasks` returns `503`.
3. In-flight tasks reach status `cancelled` with a
   `task.cancel_requested{trigger: fleet_killswitch}` audit (actor `svc:gateway`).
4. Audit: `GET /v1/events?tenant=platform&event_type=killswitch.activated`.

## In-flight handling

Each auto-cancelled task drains its in-flight wave and unwinds its compensation
stack. Compensators are **exempt** from the fleet halt (per the matrix in the
[tier-2 runbook](kill-switch-tier-2-capability.md)), which is what makes the
unwind executable under the halt. Check for incomplete unwinds:

```
GET /v1/events?tenant=<t>&event_type=compensation.completed   # status: incomplete
```

**Multi-replica residual:** the auto-canceller dedups cancels per halt episode
*within one process*. With multiple gateway replicas, a second replica may
re-emit a `task.cancel_requested` for the same task — harmless (Temporal cancel
is a no-op on an already-cancelling workflow), but expect possible duplicate
cancel audits per task.

## Reinstate / rollback

```
node scripts/kill-switch.mjs resume-fleet --reason "<why>"
```

Emits `killswitch.cleared`; intake accepts tasks again and the auto-canceller
stands down. Tasks cancelled during the halt are terminal — resubmit them.

## Quarterly drill

- **Staging only** for a real fleet halt; never drill tier 3 against production
  traffic without a change window.
- Park a task on an approval, halt the fleet, confirm the task cancels with the
  `fleet_killswitch` trigger and that new intake 503s, then resume and confirm a
  fresh task completes.
- Record on the timed sheet: flip time, observed 503 time, observed cancel time,
  deltas vs SLO.
- **Post-drill checklist:** fleet resumed; a fresh task completes; no
  DeploymentWorkflow was cancelled; `GET /v1/verify?tenant=<t>` and
  `?tenant=platform` pass; the drill's `killswitch.activated`/`cleared` pair is
  on the ledger.
