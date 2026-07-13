# DR: Postgres Backup & Restore (audit hash-chain preserving)

Recover the shared Postgres — the system of record for the audit ledger, the
pgvector knowledge corpus, and Temporal's own state — with the **audit hash
chain proven intact** as the acceptance gate. A restore is not "done" until
`GET /v1/verify` passes for every tenant.

## What lives in this Postgres

| Data | Owner | DR sensitivity |
|---|---|---|
| `audit_events` (+ `chain_seq`, `prev_hash`, `record_hash`) | audit service | **Highest** — tamper-evident, append-only, hash-chained |
| Knowledge corpus + pgvector embeddings + lineage ledger | knowledge service | High — citations reference `lineage_id` chunk versions |
| Registry, policy, evaluation, budget state | those services | Medium — self-healing/idempotent on boot |
| Temporal history/visibility (auto-setup schema) | Temporal | High — in-flight workflow durability |

The audit chain is the reason this runbook is strict. Each record's
`record_hash` is computed over a fixed envelope `{v, tenant, chain_seq,
prev_hash, event}` with algorithm tag `acp-audit-chain/v1`; genesis
`prev_hash` is `sha256:` + 64 zeros. A restore that loses, reorders, or
truncates rows breaks linkage and is detectable — which is exactly what we
verify.

## Backup

Two complementary mechanisms; run **both** in production.

1. **Base backups + WAL archiving (PITR).** Continuous archiving gives
   point-in-time recovery to any moment, which is what you want after a logical
   corruption or a bad migration. The audit columns (`chain_seq`, `prev_hash`,
   `record_hash`) are ordinary columns and are captured with everything else —
   no special handling needed; a physically consistent snapshot preserves the
   chain byte-for-byte.
2. **Logical dumps** for portability / long retention:

   ```bash
   pg_dump --format=custom --no-owner --dbname="$ACP_DATABASE_URL" \
     --file=acp-$(date +%Y%m%dT%H%M%SZ).dump
   ```

   A `--format=custom` dump preserves row order within a table on restore per
   the dump's internal ordering; the audit chain does not depend on physical row
   order (it verifies by `chain_seq`), so a logical dump is chain-safe as long
   as it is **whole** — never `--exclude-table` the audit table or any of its
   columns.

Store backups off-cluster (object storage), encrypted, with the same retention
tier as the audit WORM archive (see
[audit-integrity-and-retention.md](audit-integrity-and-retention.md)).

> **Never** `docker compose down -v` or drop the `pgdata` volume as a "reset"
> in any environment that shares state with audit — it destroys the chain.

## Restore

```text
1. Stop writers. Scale audit + knowledge + evaluation + orchestrator to zero
   (or keep the whole platform down). Restore fail-closed: ingress stays shut.
2. Provision a clean Postgres (same major, pgvector available).
3a. PITR:  restore the base backup, replay WAL to the target time, promote.
3b. Dump:  createdb, then
       pg_restore --no-owner --dbname="$ACP_DATABASE_URL" acp-<ts>.dump
4. Let each service run its idempotent boot migration (advisory-locked; see
   upgrade-rolling.md). These are no-ops against a fully-restored schema.
5. RUN THE ACCEPTANCE CHECK (below) BEFORE reopening ingress.
6. Restore NATS JetStream/KV (dr-nats-jetstream.md) — in particular the
   kill-switch KV must be restored before ingress reopens (fail-closed).
7. Reopen ingress; run a synthetic probe task end to end.
```

## Acceptance check — the audit chain must verify (do not skip)

This is the gate that makes a restore trustworthy. For **each tenant** (query
the distinct tenants, always include `platform`):

```bash
# audit:read-scoped platform token in $TOKEN; audit service on :7104
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:7104/v1/verify?tenant=$TENANT" | jq
```

The walk starts at genesis (`from_seq=1`) and re-hashes every record in
`chain_seq` order, checking sequence continuity and linkage. **Accept the
restore only if** the response is:

```json
{ "tenant": "...", "algorithm": "acp-audit-chain/v1",
  "verified": true, "records_checked": <N>, "head": { "chain_seq": <N>, ... } }
```

- `verified: false` with a `failure.kind` of `hash_mismatch`, `link_mismatch`,
  `seq_gap`, or `genesis_mismatch` means the restore lost/altered/reordered
  rows — **the restore is rejected.** Do not reopen ingress; investigate the
  backup source or restore an earlier consistent snapshot.
- A **pruned-prefix** archive (older rows moved to WORM) verifies the suffix by
  passing `from_seq=<checkpoint_seq>&anchor_prev_hash=<recorded_hash>`; the
  checkpoint hash is recorded at archival time.
- Confirm `head.chain_seq` matches the expected pre-incident head (or the PITR
  target). A verified-but-short chain means you recovered to an earlier point —
  a valid but lossy outcome to record in the incident report.

## Other stores after restore

- **Knowledge/pgvector:** citations reference `lineage_id`s. After restore,
  run a retrieval probe; a missing lineage row surfaces as a citation gap, not
  silent wrong data (answers state the gap).
- **Temporal:** if Temporal's own Postgres schema was restored to an earlier
  point, in-flight workflows resume from that point — expect duplicate-safe
  activity replays (activities are idempotent by design). Prefer restoring
  Temporal state and application state to the **same** PITR target.
