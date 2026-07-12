# Runbook — Audit integrity & retention (Audit v1)

**Owner:** `<governance-oncall>`

## The per-tenant hash chain

Every audit record carries `chain_seq`, `prev_hash`, and `record_hash`, forming a
**per-tenant** hash chain (the `platform` tenant is a tenant too, so lifecycle and
kill-switch events chain). The single sequential audit-writer computes the hash at
append time over a canonical envelope
(`{v, tenant, chain_seq, prev_hash, event}`, `stableStringify`'d), and a Postgres
`BEFORE INSERT` trigger (`audit_events_chain_check`) refuses any insert whose
linkage does not extend the tenant's head (or the genesis anchor for the first
record). A second trigger (`audit_events_append_only`) refuses all `UPDATE`/
`DELETE`. The DB checks linkage **equality** only — it never recomputes a hash in
SQL (jsonb normalization is version-fragile).

## Verify integrity

```
GET /v1/verify?tenant=<t>[&from_seq=&anchor_prev_hash=&to_seq=]   # aud acp:audit, scope audit:read
```

Walks the chain in 1000-row pages, recomputing each `record_hash` and checking
sequence continuity + linkage. Response:

```
{ tenant, algorithm, verified, records_checked, head: {chain_seq, record_hash}, failure? }
```

`failure.kind` is one of `hash_mismatch` (a record was mutated), `link_mismatch`
(a record hash was rewritten, breaking the next link), `seq_gap` (a sequence
number was skipped/injected), or `genesis_mismatch` (the first record does not
anchor at genesis). The walk stops at the first failure. A pruned-prefix
deployment verifies the **suffix** by passing `from_seq` + `anchor_prev_hash` (a
recorded archival checkpoint).

## Threat model (what the chain does / does not defeat)

**Tamper-EVIDENT against** DB mutation, deletion, insertion, and reordering: any
of these breaks a recompute or a linkage unless the attacker rewrites the entire
suffix from the tamper point to the head **and** every downstream consumer's
recorded head.

**Does NOT defeat** (a) a fully-compromised audit service that rewrites the
suffix *and* re-signs consistently, or (b) head truncation (dropping the newest
records). The v0 second factor against both is the JetStream `ACP_AUDIT` stream
(`deny_delete` + `deny_purge`, file-backed), which retains the originals for
reconciliation. Periodic external head-anchoring (publishing the head hash to an
independent store) is the hardened follow-up.

## Tamper-response procedure

1. `GET /v1/verify` reports `verified: false` with a `failure`. **Do not write the
   finding back to the ledger** — a tamper finding is an alarm (log + OTel), never
   a row in the possibly-tampered store.
2. Note `failure.chain_seq` and `failure.event_id`.
3. Reconcile against JetStream `ACP_AUDIT`: fetch the originals for that tenant and
   compare to the Postgres rows from the tamper point forward. The stream is
   deny-delete/deny-purge, so the originals are authoritative.
4. Treat a confirmed divergence as a platform security incident (the audit store
   was written to out-of-band). Rotate credentials, snapshot both stores, and open
   an incident.

## Forensic detection queries

**A completed write with no `step.completed` audit** (routed item-2 residual — a
`step.completed` audit that exhausted retries after the write completed leaves the
write compensable but its completion record missing):

```sql
-- step.dispatched with no matching step.completed for the same (task_id, step_id)
SELECT d.task_id, d.step_id
FROM audit_events d
WHERE d.event_type = 'step.dispatched'
  AND NOT EXISTS (
    SELECT 1 FROM audit_events c
    WHERE c.event_type = 'step.completed'
      AND c.task_id = d.task_id AND c.step_id = d.step_id
  );
```

Such a step's write was kept on the compensation stack (it is unwound like any
completed write); the missing record is the alarm, not a lost write.

**Task reconstruction** for a forensic narrative of one task:

```
GET /v1/tasks/:task_id/reconstruction?tenant=<t>
# or: node scripts/reconstruct-task.mjs <task_id> --tenant <t>
```

## Retention tiers

`GET /v1/retention` reports the policy:

- **Hot** (Postgres): `ACP_AUDIT_RETENTION_HOT_DAYS`, **floor 183 days** (EU AI
  Act Art.19 six-month minimum). The audit service **refuses to boot** below the
  floor. No app-code row deletion — the append-only trigger forbids it; hot
  eviction is a schema operation by deployment policy.
- **Archival** (deployment policy): export `WHERE recorded_at < cutoff` as a
  **contiguous chain prefix** and record a checkpoint `{tenant, from_seq,
  prev_hash}` so the retained suffix still verifies via the `/v1/verify` anchor.
  Back the export up alongside the JetStream stream.
- **WORM** (deployment policy): a monthly object-locked export for regulated
  tenants. Crypto-shred (per-tenant key destruction) is a future successor.

**Not shipped, and why:** monthly table partitioning would require the partition
key in the unique constraint, breaking `UNIQUE(event_id)` and therefore the
`ON CONFLICT(event_id)` idempotency the redelivery-safe append relies on. A
partitioning successor design must preserve event-id idempotency.

## Related

- [governance-and-policy.md](../architecture/governance-and-policy.md) — audit
  invariants and the compensation-exemption matrix.
- Kill-switch runbooks: [tier 1](kill-switch-tier-1-agent.md),
  [tier 2](kill-switch-tier-2-capability.md),
  [tier 3](kill-switch-tier-3-fleet.md).
