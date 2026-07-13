# Operational Levers — Stop the Bleeding

The fast controls for a live incident, and when to reach for each. These are the
**containment** levers; recovery (upgrade, restore) is a slower path once the
bleeding has stopped.

## Decision guide

| Symptom | Lever | Runbook |
|---|---|---|
| One agent version misbehaving (bad outputs, drift, runaway) | **Tier-1 kill switch** (agent) | [kill-switch-tier-1-agent.md](kill-switch-tier-1-agent.md) |
| A capability or a whole risk class is unsafe everywhere | **Tier-2 kill switch** (capability / risk class) | [kill-switch-tier-2-capability.md](kill-switch-tier-2-capability.md) |
| Systemic — stop all task intake + dispatch now | **Tier-3 kill switch** (fleet) | [kill-switch-tier-3-fleet.md](kill-switch-tier-3-fleet.md) |
| Quality regressing but not yet worth killing | **Quality freeze** (change freeze) | this page |
| Cost/budget runaway for a tenant | Per-tenant budget cap (admission 429s) | [cost-management](../architecture/cost-management.md) |
| Suspected data loss / tamper | Restore + audit chain-verify | [dr-postgres-backup-restore.md](dr-postgres-backup-restore.md) |
| Bad release rolled out | Roll back to previous image | [upgrade-rolling.md](upgrade-rolling.md) |

## Kill switches (three tiers, < 10 s propagation)

Every tier flips the fast-path **control KV first**, then emits an audit event
(`killswitch.activated` / `killswitch.cleared`) on the `platform` tenant, so
enforcement never waits on the audit round-trip. The propagation SLO is **< 10
seconds** from flip to enforcement, drilled quarterly. See the
[runbooks index](README.md) for owners and the tier table. On DR, the
kill-switch KV is restored **before** ingress reopens so a killed entity stays
killed ([dr-nats-jetstream.md](dr-nats-jetstream.md)).

## Quality freeze (change freeze)

Kill switches remove an agent from traffic. A **quality freeze** is the softer
lever: it stops *changes* to an agent (prompt/model/config) while its quality
error budget is burnt, without pulling it from service.

The online-eval engine (`packages/online-eval`) tracks a per-agent
`quality_state` on a ladder driven by the quality **burn ratio**:

| burn_ratio | quality_state | effect |
|---|---|---|
| < 0.5 | `measurable` | normal operation |
| ≥ 0.5 | `warning` | alert; budget burning |
| ≥ 1.0 | `exhausted` | **change freeze** — prompt/model/config changes blocked |
| beyond | `severe` → `floor` | routing demotion → auto-suspend at the SLO floor |

An `exhausted` (or worse) `quality_state` triggers a **change freeze** exactly
as an availability-budget burn freezes deploys: no prompt or model change to that
agent ships until quality recovers (the budget refills) or a human overrides
with justification. This is what prevents "fixing" a regressing agent by
blindly editing prompts while it is already unstable. Budget state is visible on
the registry record and on the SLO dashboards
([slo-targets.md](../standards/slo-targets.md)).

**When to use:** an agent is drifting or scoring below baseline but still
producing mostly-useful output — freeze changes, investigate, and let the ladder
demote it automatically if it worsens. **When not to:** if it is actively
producing harmful or wrong writes, kill it (tier-1) rather than freeze it.

## Order of operations in an incident

1. **Contain** — kill switch (right tier) or quality freeze. Stop the harm.
2. **Verify integrity** — `GET /v1/verify` for affected tenants; confirm no
   audit gap ([dr-postgres-backup-restore.md](dr-postgres-backup-restore.md)).
3. **Diagnose** — traces (one task = one trace), SLO dashboards, audit
   provenance (`/v1/tasks/{id}` reconstruct).
4. **Recover** — roll back ([upgrade-rolling.md](upgrade-rolling.md)) or restore
   ([dr-postgres-backup-restore.md](dr-postgres-backup-restore.md),
   [dr-nats-jetstream.md](dr-nats-jetstream.md)).
5. **Clear** — lift the switch/freeze; every clear is itself an audit event.
