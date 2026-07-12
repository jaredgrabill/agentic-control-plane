# Kill-switch & audit-integrity runbooks

Operational procedures for the three kill-switch tiers and for audit integrity /
retention. Every tier is **tested quarterly** (game days), has a **named owner**,
and requires **no vendor involvement**. Every activation is itself an audit event
(`killswitch.activated` / `killswitch.cleared`) on the `platform` tenant.

The propagation SLO for every tier is **< 10 seconds** from flip to enforcement
(the flip writes the fast-path control KV *before* emitting the audit event, so
enforcement never waits on the audit round-trip).

## Tiers

| Tier | Scope | Runbook | Owner |
|---|---|---|---|
| 1 — Agent | one agent version | [kill-switch-tier-1-agent.md](kill-switch-tier-1-agent.md) | `<agent-platform-oncall>` |
| 2 — Capability | one capability, platform-wide | [kill-switch-tier-2-capability.md](kill-switch-tier-2-capability.md) | `<governance-oncall>` |
| 2 — Risk class | a whole risk class (R1/R2/R3) | [kill-switch-tier-2-capability.md](kill-switch-tier-2-capability.md) | `<governance-oncall>` |
| 3 — Fleet | all task dispatch + intake | [kill-switch-tier-3-fleet.md](kill-switch-tier-3-fleet.md) | `<incident-commander>` |

## Audit integrity & retention

- [audit-integrity-and-retention.md](audit-integrity-and-retention.md) — the
  per-tenant hash chain, `GET /v1/verify`, the tamper-response procedure,
  retention tiers (hot floor, archival, WORM), and forensic detection queries.

## Quarterly drill cadence

Each tier is drilled once per quarter, **staging first**, using the timed
recording sheet in its runbook (measured propagation vs the 10 s SLO). Every
drill ends with the post-drill checklist, which includes confirming
`GET /v1/verify` still passes for the affected tenants.

## Related design docs

- [governance-and-policy.md](../architecture/governance-and-policy.md) — the
  three-way PDP, the compensation-exemption matrix, and the audit-integrity
  threat model.
- [agent-lifecycle.md](../architecture/agent-lifecycle.md) — the lifecycle state
  machine and the agent-tier (tier 1) kill switch.
