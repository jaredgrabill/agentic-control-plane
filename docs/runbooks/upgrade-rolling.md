# Rolling Upgrade (zero-downtime, no data loss)

How to deploy a new platform version onto a running cluster without dropping
task traffic, corrupting the shared schema, or breaking the audit hash chain.
Read [operational-levers.md](operational-levers.md) first if you are upgrading
*to stop* a live incident — an upgrade is the slow path.

## The hazards this runbook exists for

The control plane shares one Postgres and one NATS cluster across ~10 services,
and each service **self-migrates its own tables on boot** with idempotent DDL
(`CREATE ... IF NOT EXISTS`, ordered `ALTER`s; see `apps/audit/src/store.ts`
`migrate()`). A rolling deploy therefore runs **old and new code against the
same schema at the same time**. Three things can go wrong if you are careless:

1. **Mixed-schema readers.** A new pod adds a column and starts writing it while
   old pods still `SELECT` the old shape. If the new shape is not a *superset*
   of the old one, the old pods break.
2. **Migration races.** Several new pods boot at once and run the same DDL
   concurrently.
3. **Audit-enum / hash-chain damage.** Reordering or removing an
   `audit-event.event_type` value, or changing the chain envelope, silently
   invalidates every downstream `record_hash`.

## Rule 1 — Expand then contract (backward-compatible within a minor)

Within a minor version every migration is **additive and backward-compatible**:
add nullable columns, add indexes, add new `event_type` enum values, add new
NATS subjects. Never remove or retype a column, tighten a constraint, or drop an
enum value in the same release that still has readers of the old shape. A
destructive change is a **two-release expand-then-contract**:

- **Release N (expand):** add the new column/table/field; write both old and
  new; keep reading the old. Backfill.
- **Release N+1 (contract):** once every pod is on N and the backfill is done,
  switch reads to the new shape and drop the old — by then no live reader
  depends on it.

Anything that forces a consumer to change is a **breaking wire-contract change**
and is gated by [`api-versioning.md`](../standards/api-versioning.md) and the
`schema-diff` CI job — it may ship only in a **major** bump, never mid-minor.

## Rule 2 — Serialize DDL with the shared advisory lock

Concurrent pod starts must not race the same migration. Stores that mutate
schema on boot take a Postgres **transaction-scoped advisory lock** first —
`SELECT pg_advisory_xact_lock($KEY)` — so exactly one migrator runs at a time
and the rest wait then no-op on the idempotent DDL (see
`apps/gateway/src/budget.ts` and `apps/evaluation/src/service/store.ts`). When
adding a new self-migrating store, reuse this pattern with a unique lock key.
The audit store additionally keeps its migration **idempotent and ordered**
(drop triggers → add columns/index → backfill in JS → set NOT NULL → recreate
triggers) so a re-run is always safe.

## Rule 3 — Audit enum is append-only

`event_type` in `audit-event.schema.json` is a **closed, append-only**
vocabulary. Adding a new kind (e.g. a new lifecycle event) is safe and additive.
**Never** rename, renumber, or remove an existing value: historical audit
records carry it, and the per-tenant hash chain (`acp-audit-chain/v1`) binds the
serialized event into every subsequent `record_hash`. Removing or renaming a
value does not rewrite the stored rows, so `GET /v1/verify` still returns
`verified: true` — but the historical records can no longer be decoded or
schema-validated, and cross-language parity breaks. This is enforced as a
breaking change by `schema-diff` (append-only enum rule).

## Deploy order (respect the parity gate)

All services must speak a **mutually compatible** contract at every instant, so
deploy in dependency order, protocol-compatible layer first:

1. **Regenerate + verify contracts.** If the release touched
   `packages/protocol/schemas`, confirm `pnpm gen` was committed for both
   languages and the `contracts` + `parity` CI gates are green on the release
   commit. A backward-compatible (minor/additive) protocol change is safe to
   roll under mixed versions; a major one requires the whole fleet cut together
   (or an expand-then-contract protocol migration).
2. **Producers before consumers.** Roll the services that *emit* a new
   additive field before the ones that *require* reading it. New fields are
   optional on the way in, so old consumers ignore them safely.
3. **One service at a time, behind `/healthz`.** For each of the nine HTTP
   services (token 7101, registry 7102, policy 7103, audit 7104, knowledge
   7105, tool-gateway 7106, llm-gateway 7107, gateway 7100, evaluation 7108):
   bring up the new replica, wait for `/healthz` to pass (the same gate
   `scripts/run-platform.mjs` uses), then retire an old replica. The Helm chart
   wires these probes ([deploy-helm.md](deploy-helm.md)); do not advance while a
   new pod is `CrashLoopBackOff`.
4. **Orchestrator drains, never hard-restarts.** The orchestrator is a Temporal
   worker with no HTTP door. Roll it by **task-queue versioning**: start the new
   worker polling, let the old worker finish in-flight workflows (Temporal
   sticky execution + drain), then stop the old one. Agents are versioned
   workers on `agent-{id}@{version}` queues — a new agent version is a new
   queue, so old and new coexist and the registry routes traffic by lifecycle
   state, not by a restart.

## Procedure

```text
0. Pre-flight
   - CI green on the release commit (contracts, parity, schema-diff, e2e).
   - Confirm the release is a minor (additive) upgrade. If it carries a
     breaking protocol change, STOP — that is a major cut, not a rolling
     minor upgrade; plan an expand-then-contract or a full-fleet window.
   - Snapshot: take a Postgres base backup and a JetStream stream/KV backup
     (dr-postgres-backup-restore.md, dr-nats-jetstream.md) so rollback has a
     restore point.
1. Apply expand migrations (idempotent, advisory-locked). Backfill if needed.
2. Roll producers one at a time behind /healthz. Verify parity stays green.
3. Roll consumers one at a time behind /healthz.
4. Roll the orchestrator + agent workers by task-queue versioning; drain old.
5. Post-deploy verification (below).
6. If clean and this was the expand half of a destructive change, schedule the
   contract release once the fleet is fully on N and the backfill is verified.
```

## Post-deploy verification

- Every `/healthz` green; Temporal shows the new worker build ID polling and the
  old one drained to zero.
- A synthetic task completes end to end (the prober; `scripts/probes.mjs`).
- **Audit chain intact:** `GET /v1/verify?tenant=<t>` returns `verified: true`
  for each active tenant (the migration must not have perturbed the chain).
- SLO dashboards ([slo-targets.md](../standards/slo-targets.md)) show no burn:
  dispatch success, task-latency p95, queue depth back to baseline.

## Rollback

Because the upgrade is expand-only within a minor, rollback is a **redeploy of
the previous image** — the old code still reads the expanded schema (new columns
are nullable/ignored). Do **not** run a "contract" (drop-column) migration as
part of a rollback. If a release had already contracted a column you now need,
restore from the pre-flight snapshot ([dr-postgres-backup-restore.md](dr-postgres-backup-restore.md))
and re-run the audit chain-verify acceptance check before reopening ingress.

## Cutting a release (and the manual-tag fallback)

Versions and changelogs are normally cut by **release-please**
([`release-please-config.json`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/release-please-config.json)):
Conventional Commits on `main` drive per-package version bumps and open a
release PR; merging it tags each package (e.g. `protocol-v1.0.0`), which the
[`docs-release`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/.github/workflows/docs-release.yml)
workflow turns into a versioned docs site. The compatibility rules that decide
the bump are in [api-versioning.md](../standards/api-versioning.md).

> **Human dependency (release-please blocker).** release-please can only open
> its release PR once the repository setting **Settings → Actions → General →
> Workflow permissions → "Allow GitHub Actions to create and approve pull
> requests"** is enabled. Until an admin sets it, no release PR appears.

**Manual signed-tag fallback** — cut a release (including 1.0) by hand if the
automation is blocked. This is a governance-grade action: the tag is
**annotated and GPG-signed** so the release point is verifiable.

1. Land all release commits on `main`; confirm CI is green (including the
   `api-freeze` gate — a 1.0 tag must ship a frozen, non-regressed contract).
2. Bump the versions by hand: edit the package `version` fields and
   [`.release-please-manifest.json`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/.release-please-manifest.json)
   to the release version, and write the `CHANGELOG.md` entries from the
   Conventional Commit history (`git log`).
3. Tag each released component with a signed annotated tag and push it:

   ```bash
   git tag -s protocol-v1.0.0 -m "protocol 1.0.0"
   git push origin protocol-v1.0.0
   # repeat per released component: agent-sdk-v1.0.0, acp-protocol-v1.0.0, …
   ```

   Pushing a `*-v1.0.0` tag triggers `docs-release` exactly as the automation
   would, so the versioned docs site publishes either way.
4. When the Actions setting is later enabled, resume the automated path — a
   `Release-As: <version>` footer on a commit re-syncs release-please to the
   manually-tagged state.
