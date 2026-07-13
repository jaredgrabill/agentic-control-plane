import { StorageType, type KV, type NatsConnection } from 'nats';
import {
  assertTenantId,
  sha256Digest,
  stableStringify,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { SearchResult } from './search.js';

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

/**
 * A cached retrieval context. Holds ONLY reconstructable retrieval output —
 * the assembled `SearchResult[]` (chunk text + full citations) and the
 * provenance needed to re-emit `retrieval.served` on a hit. It never holds
 * execution state (loop position, plan progress, conversation memory): those
 * live in Temporal history, not here (messaging-and-discovery.md
 * state-discipline — a cache is loss-tolerant, task state must not be).
 */
export interface SessionCacheEntry {
  v: number;
  tenant: string;
  /** The hex permission-snapshot digest — re-checked on read as defense in depth. */
  perm_hash: string;
  /** The hex query-snapshot digest — re-checked on read as defense in depth. */
  query_hash: string;
  /** The assembled retrieval context the answer builder needs. */
  results: SearchResult[];
  /** Distinct source_ids the results came from — the eviction handles. */
  sources: string[];
  /** The generation captured for each source at write time (source_id → gen). */
  gens: Record<string, string>;
  /** The exact lineage_ids served, so a hit re-emits an accurate retrieval.served. */
  lineage_ids: string[];
  written_at: string;
  /** ms epoch; `min(now + ttlMs, claims.exp*1000)` so the cache never outlives the token. */
  expires_at: number;
}

/**
 * The narrow slice of the NATS KV surface the cache uses. The real `KV`
 * satisfies it structurally; an in-memory fake implements it for unit tests.
 */
export interface SessionCacheKv {
  get(key: string): Promise<{ string(): string } | null>;
  put(key: string, value: string): Promise<number>;
  delete(key: string): Promise<void>;
}

export type CachePutResult = 'ok' | 'too_large' | 'error';

export type CacheRequestResult =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'expired'
  | 'disabled'
  | 'bypassed';

/**
 * Observability sink for the cache. Defined here (shared) so SearchService can
 * record outcomes without importing the OTel-backed implementation; a no-op /
 * absent recorder leaves the flow correct and untouched.
 */
export interface SessionCacheMetrics {
  request(result: CacheRequestResult): void;
  write(result: CachePutResult): void;
  eviction(cause: 'stale' | 'expired'): void;
}

export type EntryValidation =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'tenant_mismatch' | 'perm_mismatch' | 'query_mismatch' | 'stale'; source_id?: string };

/**
 * Validates a fetched entry against the caller's freshly-derived key parts,
 * the live generation view, and the clock. Pure, so the security-critical
 * checks — TTL ≤ token, permission/tenant re-binding, lineage staleness — are
 * unit-tested directly. Every failure is a MISS (fail-safe): the caller runs
 * the live path and never serves a stale-wrong or foreign-permission result.
 */
export function validateEntry(
  entry: SessionCacheEntry,
  expected: { tenant: string; permHashHex: string; queryHashHex: string },
  currentGen: (tenant: string, sourceId: string) => string,
  nowMs: number,
): EntryValidation {
  if (nowMs >= entry.expires_at) return { ok: false, reason: 'expired' };
  // The key already encodes tenant/perm/query, so a mismatch here can only
  // mean a corrupted or collided entry — refuse it rather than serve it.
  if (entry.tenant !== expected.tenant) return { ok: false, reason: 'tenant_mismatch' };
  if (entry.perm_hash !== expected.permHashHex) return { ok: false, reason: 'perm_mismatch' };
  if (entry.query_hash !== expected.queryHashHex) return { ok: false, reason: 'query_mismatch' };
  for (const source of entry.sources) {
    if (currentGen(entry.tenant, source) !== (entry.gens[source] ?? '')) {
      return { ok: false, reason: 'stale', source_id: source };
    }
  }
  return { ok: true };
}

/**
 * The memory-backed KV read/write door. Get and put are best-effort: any KV
 * error is swallowed and reported to the caller as a miss / write-failure, so
 * a cache fault degrades to correct live retrieval and never surfaces an error
 * on the retrieval hot path.
 */
export class SessionContextCache {
  constructor(
    private readonly kv: SessionCacheKv,
    private readonly maxValueBytes: number,
    private readonly logger: Logger,
  ) {}

  async get(key: string): Promise<SessionCacheEntry | undefined> {
    try {
      const entry = await this.kv.get(key);
      if (entry === null) return undefined;
      return JSON.parse(entry.string()) as SessionCacheEntry;
    } catch (err) {
      this.logger.warn({ err }, 'session cache get failed — treating as a miss');
      return undefined;
    }
  }

  async put(key: string, entry: SessionCacheEntry): Promise<CachePutResult> {
    let payload: string;
    try {
      payload = JSON.stringify(entry);
    } catch (err) {
      this.logger.warn({ err }, 'session cache entry could not be serialized — skipping write');
      return 'error';
    }
    // Oversize entries are skipped, not truncated: a partial retrieval context
    // would be a correctness bug. The live path already returned the full result.
    if (Buffer.byteLength(payload, 'utf8') > this.maxValueBytes) return 'too_large';
    try {
      await this.kv.put(key, payload);
      return 'ok';
    } catch (err) {
      this.logger.warn({ err }, 'session cache put failed — served live, uncached');
      return 'error';
    }
  }

  async evict(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
    } catch (err) {
      this.logger.warn({ err }, 'session cache evict failed (harmless — entry ages out via TTL)');
    }
  }
}

export interface SessionCacheBucketOptions {
  maxValueBytes: number;
  maxBytes: number;
  /** Backstop TTL on every key; per-entry expiry (≤ token TTL) is enforced on read. */
  ttlMs: number;
}

/**
 * Creates (or binds) the single MEMORY-storage session cache bucket. Memory
 * storage is deliberate: classified retrieval context must never land on disk,
 * and a restart resets entries and their captured generations together, so the
 * two views can never disagree. history:1 — only the latest value per key
 * matters. The generation keys (`gen.>`) live in the same bucket.
 */
/* v8 ignore start -- bucket creation needs a live JetStream; exercised by the E2E suite */
export async function ensureSessionCacheBucket(
  nc: NatsConnection,
  opts: SessionCacheBucketOptions,
): Promise<KV> {
  return nc.jetstream().views.kv(SESSION_CACHE_BUCKET, {
    history: 1,
    storage: StorageType.Memory,
    maxValueSize: opts.maxValueBytes,
    max_bytes: opts.maxBytes,
    ttl: opts.ttlMs,
  });
}
/* v8 ignore stop */
