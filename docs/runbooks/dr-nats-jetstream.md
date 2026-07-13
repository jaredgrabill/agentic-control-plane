# DR: NATS JetStream & KV Backup / Restore

Recover the messaging substrate: the JetStream **streams** (audit/event/task
durability) and the **KV buckets** (kill-switch denylist, session context cache,
tenant state). The one rule that makes this safe: **restore the kill-switch KV
before you reopen ingress** — the platform recovers fail-closed.

## What JetStream holds

| Object | Kind | DR sensitivity |
|---|---|---|
| Audit / event / task streams | JetStream stream | High — durable event log, replays |
| Kill-switch denylist | KV bucket (control plane) | **Restore first** — a killed agent/capability must stay killed |
| Session context cache | KV bucket, TTL-bound | Low — permission-snapshot keyed, safe to lose (rebuilds live) |
| Tenant state / per-tenant budget markers | KV bucket | Medium |
| Per-tenant account boundaries | NATS server config (`nats-accounts.gen.conf`) | Config, not data — versioned in git |

Accounts and auth-callout config are **generated from `deploy/dev/tenants.json`**
(`scripts/gen-nats-accounts.mjs`) and live in git, not in a backup — recover
them by redeploying config, not by restoring server state.

## Backup

```bash
# Streams: one archive per stream (schema + messages + consumer state).
nats stream backup AUDIT   ./nats-backup/AUDIT
nats stream backup EVENTS  ./nats-backup/EVENTS
nats stream backup TASKS   ./nats-backup/TASKS

# KV buckets are streams under the hood (KV_<bucket>); back them up the same way.
nats stream backup KV_killswitch ./nats-backup/KV_killswitch
nats stream backup KV_tenant     ./nats-backup/KV_tenant
# The session cache is a rebuildable TTL cache — back up only if cheap.
```

Snapshot on a cadence matched to the audit archive; store off-cluster and
encrypted. The audit **stream** is a convenience replay layer — the tamper-
evident system of record is Postgres (`dr-postgres-backup-restore.md`); if the
two disagree after a restore, Postgres + `GET /v1/verify` is authoritative.

## Restore (ordered — fail-closed)

```text
1. Keep ingress CLOSED. The public gateway (:7100) must not accept tasks yet.
2. Bring up NATS with the git-versioned server config (accounts + auth callout).
3. Restore the KILL-SWITCH KV FIRST:
       nats stream restore KV_killswitch < ./nats-backup/KV_killswitch
   Verify the denylist contents match the last known control state BEFORE any
   traffic can flow. A killed agent/capability/fleet must be re-killed on
   recovery — never resurrect serving for an entity that was under a kill
   switch at snapshot time.
4. Restore tenant/budget KV:
       nats stream restore KV_tenant < ./nats-backup/KV_tenant
5. Restore the durable streams:
       nats stream restore AUDIT  < ./nats-backup/AUDIT
       nats stream restore EVENTS < ./nats-backup/EVENTS
       nats stream restore TASKS  < ./nats-backup/TASKS
6. (Session cache KV: recreate the bucket empty if not restored — it repopulates
    on the retrieval hot path, permission-snapshot keyed, TTL-bound.)
7. Start services; confirm each /healthz and that the auth callout mints bus
    sessions into the correct per-tenant account (a task from tenant A must not
    land in tenant B's account).
8. ONLY NOW reopen ingress. Run a synthetic probe task end to end.
```

## Why kill-switch-first is non-negotiable

The kill switch is the platform's "stop the bleeding" lever
([operational-levers.md](operational-levers.md)) and its propagation SLO is
**< 10 s** — enforcement reads the fast-path control KV. During recovery there
is a window where services are up but ingress could open. If the denylist KV is
empty in that window, a previously-killed rogue or regressed agent would serve
again. Restoring the denylist **before** ingress closes that window: the default
on recovery is *deny what was denied*.

## Verification

- `nats stream info` shows expected message counts / last-seq per stream.
- Kill-switch KV keys match the pre-incident control state (spot-check the
  entities that were killed).
- Cross-check the audit **stream** tail against the Postgres audit head
  (`GET /v1/verify` `head.chain_seq`); Postgres wins on any disagreement.
- Tenant isolation probe: submit a task per tenant, confirm subjects stay within
  `acp.<tenant>.*` and the correct account.
