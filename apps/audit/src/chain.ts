/**
 * Per-tenant tamper-evident hash chain over the audit ledger (item 5, Audit v1).
 *
 * The chain is computed by the single sequential audit-writer at append time and
 * enforced by a Postgres BEFORE-INSERT trigger (see store.ts). This module holds
 * the PURE, side-effect-free pieces — the record-hash canonicalization and the
 * verifier walk — so they are unit-testable without a database and identical on
 * every code path that must agree (append, backfill, and /v1/verify).
 *
 * Canonicalization (D7): record_hash = sha256 over the stableStringify of a
 * fixed-key envelope {v, tenant, chain_seq, prev_hash, event}. stableStringify
 * (service-kit) sorts keys recursively and drops undefined, so jsonb key-order
 * normalization on round-trip cannot change the hash; float64 values re-render
 * to their shortest form identically on both sides. The DB NEVER recomputes a
 * hash — it checks linkage EQUALITY only — because SQL jsonb normalization is
 * version-fragile.
 */

import type { AuditEvent } from '@acp/protocol';
import { sha256Digest, stableStringify } from '@acp/service-kit';

/** The chain algorithm tag, bound into every record hash so a format change is detectable. */
export const CHAIN_ALGORITHM = 'acp-audit-chain/v1';
/** Genesis anchor: the prev_hash of chain_seq 1 for every tenant. */
export const GENESIS_PREV_HASH = `sha256:${'0'.repeat(64)}`;

/**
 * Computes a record's chain hash over the canonical envelope. `event` is the
 * PARSED audit event (from memory on append, from jsonb on verify/backfill);
 * stableStringify makes the two representations hash identically.
 */
export function computeRecordHash(input: {
  tenant: string;
  chainSeq: number;
  prevHash: string;
  event: unknown;
}): string {
  return sha256Digest(
    stableStringify({
      v: CHAIN_ALGORITHM,
      tenant: input.tenant,
      chain_seq: input.chainSeq,
      prev_hash: input.prevHash,
      event: input.event,
    }),
  );
}

/** One stored chain row, as read for verification. */
export interface ChainRow {
  chain_seq: number;
  prev_hash: string;
  record_hash: string;
  event: AuditEvent;
}

export type ChainFailureKind =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'genesis_mismatch';

export interface ChainFailure {
  chain_seq: number;
  event_id: string;
  kind: ChainFailureKind;
}

/** The walk cursor carried across paged verification (seq expected next, and the prev_hash it must present). */
export interface ChainAnchor {
  seq: number;
  prevHash: string;
}

export type VerifyPageResult =
  | { ok: true; checked: number; anchor: ChainAnchor }
  | { ok: false; checked: number; failure: ChainFailure };

/**
 * Verifies one contiguous, chain_seq-ascending page against an incoming anchor,
 * returning the outgoing anchor (to continue the next page) or the FIRST failure.
 * Checks, per row and in order: sequence continuity (seq_gap), linkage
 * (genesis_mismatch at seq 1, else link_mismatch), then the recomputed record
 * hash (hash_mismatch). The first failure stops the walk — a mutated record
 * breaks its own recompute; a rewritten record breaks the NEXT row's linkage
 * unless the whole suffix is rewritten (threat model §4).
 */
export function verifyChainPage(tenant: string, rows: ChainRow[], anchor: ChainAnchor): VerifyPageResult {
  let seq = anchor.seq;
  let prevHash = anchor.prevHash;
  let checked = 0;
  for (const row of rows) {
    const eventId = row.event.event_id;
    if (row.chain_seq !== seq) {
      return { ok: false, checked, failure: { chain_seq: row.chain_seq, event_id: eventId, kind: 'seq_gap' } };
    }
    if (row.prev_hash !== prevHash) {
      return {
        ok: false,
        checked,
        failure: {
          chain_seq: seq,
          event_id: eventId,
          kind: seq === 1 ? 'genesis_mismatch' : 'link_mismatch',
        },
      };
    }
    const recomputed = computeRecordHash({
      tenant,
      chainSeq: row.chain_seq,
      prevHash: row.prev_hash,
      event: row.event,
    });
    if (recomputed !== row.record_hash) {
      return { ok: false, checked, failure: { chain_seq: seq, event_id: eventId, kind: 'hash_mismatch' } };
    }
    checked += 1;
    prevHash = row.record_hash;
    seq += 1;
  }
  return { ok: true, checked, anchor: { seq, prevHash } };
}
