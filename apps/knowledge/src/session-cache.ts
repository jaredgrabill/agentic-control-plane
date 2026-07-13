import { assertTenantId, sha256Digest, stableStringify, type PlatformClaims } from '@acp/service-kit';

/**
 * The session context cache memoizes the EXPENSIVE, permission-invariant half
 * of retrieval — `embedder.embed()` + `store.search()` — under a key derived
 * from the caller's VERIFIED effective permissions. Authorization is never
 * cached: `SearchService.search` re-runs `verify()` + Cedar on every call and
 * a hit still emits `retrieval.served`. This module holds the security crux —
 * the key derivation whose only job is to make a cross-principal or
 * cross-tenant hit STRUCTURALLY impossible.
 *
 * Storage lives in a MEMORY-backed NATS KV bucket (classified retrieval
 * context never touches disk; a restart resets entries and their captured
 * generations together, so the two can never disagree).
 */

/** Bump when the key inputs or the value shape change — old entries become unreadable, not mis-read. */
export const CACHE_SCHEMA_VERSION = 1;

/** One memory-storage KV bucket per deployment. */
export const SESSION_CACHE_BUCKET = 'acp_session_cache';

export type SearchMode = 'hybrid' | 'vector' | 'lexical';

/** Default query breadth, mirrored from SearchService so the key snapshot matches what runs. */
const DEFAULT_K = 8;
const MAX_K = 50;
const DEFAULT_MODE: SearchMode = 'hybrid';

/** sha256Digest returns `sha256:<hex>`; the key carries the bare hex (`.`/`>` free, KV-legal). */
function hex(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
}

/**
 * The generation key for a source: `gen.<tenant>.<source_id>`. Mirrors the
 * kill-switch key families (a leading literal token, then the validated
 * tenant). Bumping this value invalidates every cached entry that captured a
 * now-stale generation for the source, across all permission snapshots in the
 * tenant. source_id is producer-controlled but only ever read back through the
 * watcher's in-memory map — it is never re-emitted into an entry key.
 */
export function genKey(tenant: string, sourceId: string): string {
  return `gen.${assertTenantId(tenant)}.${sourceId}`;
}

/**
 * The permission snapshot: the ONLY inputs that decide which chunks a caller
 * may see, taken exclusively from VERIFIED claims (never a request parameter).
 * Tenant is `assertTenantId`-validated AND embedded here (defense in depth with
 * the key prefix). actor is the acting principal (act.sub ?? sub); scopes and
 * the classifications they authorize are sorted so property/set order can never
 * fork the hash.
 */
export interface PermSnapshot {
  v: number;
  tenant: string;
  actor: string;
  scopes: string[];
  classifications: string[];
  embedding_model: string;
}

export interface PermSnapshotInput {
  claims: Pick<PlatformClaims, 'tenant' | 'sub' | 'act'>;
  scopes: string[];
  classifications: string[];
  embeddingModel: string;
}

export function permSnapshot(input: PermSnapshotInput): PermSnapshot {
  return {
    v: CACHE_SCHEMA_VERSION,
    tenant: assertTenantId(input.claims.tenant),
    actor: input.claims.act?.sub ?? input.claims.sub,
    scopes: [...input.scopes].sort(),
    classifications: [...input.classifications].sort(),
    embedding_model: input.embeddingModel,
  };
}

export interface QuerySnapshotInput {
  query: string;
  k?: number | undefined;
  sourceId?: string | undefined;
  mode?: SearchMode | undefined;
  embeddingModel: string;
}

/**
 * The query snapshot: everything that changes WHICH results a search returns
 * for a fixed permission set. The query text is normalized (trim) and k is
 * clamped exactly as SearchService clamps it, so the cached snapshot describes
 * the search that actually ran. embedding_model is included so a model change
 * (which changes both the query vector and the stored vectors) forks the key.
 */
export interface CacheKeyInput extends PermSnapshotInput, QuerySnapshotInput {}

export interface CacheKey {
  /** `${tenant}.${permHashHex}.${queryHashHex}` — the KV entry key. */
  key: string;
  tenant: string;
  permHashHex: string;
  queryHashHex: string;
}

/**
 * Derives the entry key from the permission snapshot and the query snapshot.
 *
 * Collision-resistance / isolation argument (the security crux):
 *  (1) The key is NOT attacker-controllable. permHash is a deterministic
 *      function of VERIFIED claims (tenant, actor, scopes, classifications,
 *      embedding_model); a caller cannot choose its own scopes/tenant/actor.
 *      Only the query influences queryHash.
 *  (2) Every read and write uses the caller's OWN derived permHash; no request
 *      path accepts a permHash or reads by a foreign prefix. A cross-principal
 *      hit is therefore structurally impossible, independent of hash strength.
 *  (3) Two principals share a key IFF their {tenant, actor, scopes,
 *      classifications, embedding_model} are identical — i.e. the same
 *      principal with the same grant, whose authorized view is identical by
 *      construction. Sharing is then CORRECT, not a leak.
 *  (4) Any permission change (narrowed scope, dropped classification, new
 *      delegated actor) yields a different permHash → a different key → the
 *      pre-change (broader) entry is unreachable and ages out via TTL.
 *  (5) Cross-tenant is doubly closed: tenant is inside the hashed snapshot AND
 *      the validated leading key token.
 */
export function deriveCacheKey(input: CacheKeyInput): CacheKey {
  const perm = permSnapshot(input);
  const permHashHex = hex(sha256Digest(stableStringify(perm)));
  const query = {
    q: input.query.trim(),
    k: Math.min(input.k ?? DEFAULT_K, MAX_K),
    source_id: input.sourceId ?? null,
    mode: input.mode ?? DEFAULT_MODE,
    embedding_model: input.embeddingModel,
  };
  const queryHashHex = hex(sha256Digest(stableStringify(query)));
  return { key: `${perm.tenant}.${permHashHex}.${queryHashHex}`, tenant: perm.tenant, permHashHex, queryHashHex };
}
