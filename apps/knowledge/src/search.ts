import { randomUUID } from 'node:crypto';
import type { AuditEvent, Citation } from '@acp/protocol';
import {
  AuthError,
  delegationChain,
  scopesOf,
  sha256Digest,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { Embedder } from './embedding.js';
import {
  CACHE_SCHEMA_VERSION,
  deriveCacheKey,
  validateEntry,
  type CachePutResult,
  type SessionCacheEntry,
  type SessionCacheMetrics,
} from './session-cache.js';
import type { KnowledgeStore, SearchHit } from './store.js';

/** Default per-entry TTL when none is configured; always clamped to the token's own expiry. */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * The cache read/write surface SearchService needs. SessionContextCache
 * satisfies it; a fake satisfies it in unit tests.
 */
export interface CachePort {
  get(key: string): Promise<SessionCacheEntry | undefined>;
  put(key: string, entry: SessionCacheEntry): Promise<CachePutResult>;
  evict(key: string): Promise<void>;
}

/** The live generation view. SessionCacheGenerations satisfies it. */
export interface GenerationsPort {
  current(tenant: string, sourceId: string): string;
  isReady(): boolean;
}

/** The kill-switch reads the cache honors. KillSwitchWatcher satisfies it. */
export interface KillSwitchPort {
  fleetHalt(): unknown;
  tenantHalt(tenant: string): unknown;
  principalDenied(sub: string): unknown;
}

export const KNOWLEDGE_AUDIENCE = 'acp:knowledge';

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require-approval';
  bundle_version: string;
  determining_policies: string[];
}

export interface PolicyClient {
  authorize(request: {
    principal: { type: string; id: string; attrs: Record<string, unknown> };
    action: string;
    resource: { type: string; id: string; attrs: Record<string, unknown> };
    context: Record<string, unknown>;
    reason?: Record<string, unknown>;
  }): Promise<PolicyDecision>;
}

export interface SearchRequest {
  token: string;
  query: string;
  k?: number | undefined;
  source_id?: string | undefined;
  mode?: 'hybrid' | 'vector' | 'lexical' | undefined;
  task_id?: string | undefined;
  step_id?: string | undefined;
}

export interface SearchResult {
  content: string;
  score: number;
  citation: Citation;
}

export interface SearchDeps {
  verifier: JwtVerifier;
  store: KnowledgeStore;
  embedder: Embedder;
  policy: PolicyClient;
  audit: { publish(event: AuditEvent): Promise<void> };
  logger: Logger;
  now?: () => Date;
  /**
   * Session context cache (optional — absent means the feature is off and every
   * search runs the live path). Authorization is NEVER cached: verify() + Cedar
   * still gate every call and a hit still emits retrieval.served. The cache only
   * memoizes embed() + store.search().
   */
  cache?: CachePort;
  gens?: GenerationsPort;
  killSwitch?: KillSwitchPort;
  /** Per-entry TTL before clamping to the token expiry (default 60s). */
  cacheTtlMs?: number;
  cacheMetrics?: SessionCacheMetrics;
}

/**
 * The retrieval door. Every call: verify the delegated token → Cedar
 * decision (the Knowledge Service is the PEP for retrieval) →
 * classification-filtered hybrid search → retrieval.served audit event
 * recording exactly which lineage_ids were served.
 */
export class SearchService {
  constructor(private readonly deps: SearchDeps) {}

  async search(request: SearchRequest): Promise<SearchResult[]> {
    if (typeof request.query !== 'string' || request.query.trim() === '') {
      throw new AuthError('query is required', 400);
    }
    const claims = await this.deps.verifier.verify(request.token, KNOWLEDGE_AUDIENCE);
    const scopes = scopesOf(claims);
    const actor = claims.act?.sub ?? claims.sub;

    const decision = await this.deps.policy.authorize({
      principal: {
        type: actor.startsWith('agent:') ? 'Agent' : 'User',
        id: actor,
        attrs: { tenant: claims.tenant },
      },
      action: 'knowledge.search',
      resource: { type: 'Corpus', id: claims.tenant, attrs: { tenant: claims.tenant } },
      context: { scopes, tenant: claims.tenant },
      reason: {
        ...(request.task_id !== undefined ? { task_id: request.task_id } : {}),
        ...(request.step_id !== undefined ? { step_id: request.step_id } : {}),
        tenant: claims.tenant,
      },
    });
    // Verify-only PEP: anything other than a clean allow fails closed. A
    // three-way require-approval (no R2 knowledge capability exists yet) is
    // refused here too — this inner PEP never suspends.
    if (decision.decision !== 'allow') {
      throw new AuthError(
        `Cedar decision: ${decision.decision} for knowledge.search by ${actor} ` +
          `(bundle ${decision.bundle_version}); the delegated token lacks a scope any permit ` +
          'accepts (or the action requires an approval this PEP cannot grant)',
        403,
      );
    }

    const classifications = allowedClassifications(scopes);
    const k = Math.min(request.k ?? 8, 50);
    const embeddingModel = this.deps.embedder.model;
    const nowDate = this.deps.now?.() ?? new Date();
    const nowMs = nowDate.getTime();

    // Normalize the query once so the cache key and the live embedding/search
    // operate on identical text — a trailing-space variant must not fork the
    // key from the results it stands for.
    const query = request.query.trim();

    // The cache memoizes ONLY the post-authorization retrieval. The key is
    // derived from the caller's VERIFIED effective permissions, so a hit can
    // only ever be the caller's own previously-authorized view.
    const cacheCtx = this.cacheContext(claims, actor);
    let derived: ReturnType<typeof deriveCacheKey> | undefined;
    if (cacheCtx.ready) {
      try {
        derived = deriveCacheKey({
          claims,
          scopes,
          classifications,
          embeddingModel,
          query,
          k,
          sourceId: request.source_id,
          mode: request.mode,
        });
      } catch {
        // Key derivation must never break the retrieval hot path — degrade to
        // live retrieval (the fail-safe invariant), counting a cache no-op.
        derived = undefined;
        this.deps.cacheMetrics?.request('disabled');
      }
    }
    if (cacheCtx.ready && derived !== undefined) {
      const entry = await cacheCtx.cache.get(derived.key);
      if (entry !== undefined) {
        const check = validateEntry(
          entry,
          {
            tenant: derived.tenant,
            permHashHex: derived.permHashHex,
            queryHashHex: derived.queryHashHex,
          },
          (t, s) => cacheCtx.gens.current(t, s),
          nowMs,
        );
        if (check.ok) {
          this.deps.cacheMetrics?.request('hit');
          // A hit STILL re-runs authz (above) and STILL emits retrieval.served
          // with the exact lineage_ids that were originally served.
          await this.publishServed(
            claims,
            actor,
            decision,
            request,
            entry.lineage_ids,
            nowDate,
            'hit',
          );
          return entry.results;
        }
        // Any invalid entry is a miss; stale/expired are also evicted eagerly.
        this.deps.cacheMetrics?.request(
          check.reason === 'stale' ? 'stale' : check.reason === 'expired' ? 'expired' : 'miss',
        );
        if (check.reason === 'stale' || check.reason === 'expired') {
          this.deps.cacheMetrics?.eviction(check.reason);
          await cacheCtx.cache.evict(derived.key);
        }
      } else {
        this.deps.cacheMetrics?.request('miss');
      }
    } else if (!cacheCtx.ready) {
      this.deps.cacheMetrics?.request(cacheCtx.reason);
    }

    const hits = await this.deps.store.search(this.deps.embedder.embed(query), query, k, {
      tenant: claims.tenant,
      classifications,
      sourceId: request.source_id,
      mode: request.mode,
    });
    const results = hits.map(toResult);

    // Write-through on a miss: best-effort, errors swallowed by put(). The
    // captured generations are the eviction handles; expires_at is clamped to
    // the token so a cached entry can never outlive the authorization behind it.
    if (cacheCtx.ready && derived !== undefined) {
      const sources = [...new Set(hits.map((h) => h.source_id))];
      const gens: Record<string, string> = {};
      for (const source of sources) gens[source] = cacheCtx.gens.current(claims.tenant, source);
      const entry: SessionCacheEntry = {
        v: CACHE_SCHEMA_VERSION,
        tenant: claims.tenant,
        perm_hash: derived.permHashHex,
        query_hash: derived.queryHashHex,
        results,
        sources,
        gens,
        lineage_ids: hits.map((h) => h.lineage_id),
        written_at: nowDate.toISOString(),
        expires_at: cacheExpiry(nowMs, this.deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, claims.exp),
      };
      // NB: keep the put OUTSIDE the optional-chain argument — `a?.write(put())`
      // would skip the put entirely when no metrics recorder is configured.
      const writeResult = await cacheCtx.cache.put(derived.key, entry);
      this.deps.cacheMetrics?.write(writeResult);
    }

    await this.publishServed(
      claims,
      actor,
      decision,
      request,
      hits.map((h) => h.lineage_id),
      nowDate,
      cacheCtx.ready && derived !== undefined ? 'miss' : undefined,
    );

    return results;
  }

  /**
   * Whether the cache may serve/populate this call, and if so the bound cache +
   * generations. 'disabled' when the feature is off or the generation view is
   * not yet seeded (fail-safe: never read against an incomplete staleness
   * view). 'bypassed' when a fleet/tenant halt or a principal denial is in
   * force — a being-revoked principal or a halted tenant must not be served
   * cached context.
   */
  private cacheContext(
    claims: Pick<PlatformClaims, 'tenant'>,
    actor: string,
  ):
    | { ready: true; cache: CachePort; gens: GenerationsPort }
    | { ready: false; reason: 'disabled' | 'bypassed' } {
    const { cache, gens, killSwitch } = this.deps;
    if (cache === undefined || gens === undefined) return { ready: false, reason: 'disabled' };
    // Not yet seeded → serve live rather than read an incomplete staleness view.
    if (!gens.isReady()) return { ready: false, reason: 'disabled' };
    if (killSwitch !== undefined) {
      const halted =
        killSwitch.fleetHalt() !== undefined ||
        killSwitch.tenantHalt(claims.tenant) !== undefined ||
        killSwitch.principalDenied(actor) !== undefined;
      if (halted) return { ready: false, reason: 'bypassed' };
    }
    return { ready: true, cache, gens };
  }

  private async publishServed(
    claims: PlatformClaims,
    actor: string,
    decision: PolicyDecision,
    request: SearchRequest,
    lineageIds: string[],
    now: Date,
    cache: 'hit' | 'miss' | undefined,
  ): Promise<void> {
    // Retrieval events record the lineage_ids they served: "what exactly did
    // the agent read at that second" stays a join, not forensics.
    try {
      await this.deps.audit.publish({
        event_id: randomUUID(),
        occurred_at: now.toISOString(),
        tenant: claims.tenant,
        event_type: 'retrieval.served',
        actor: { principal: actor, delegation_chain: delegationChain(claims) },
        action: { name: 'knowledge.search', inputs_digest: sha256Digest(request.query) },
        reason: {
          ...(request.task_id !== undefined ? { task_id: request.task_id } : {}),
          ...(request.step_id !== undefined ? { step_id: request.step_id } : {}),
          policy: {
            decision: decision.decision,
            bundle_version: decision.bundle_version,
            determining_policies: decision.determining_policies,
          },
        },
        ...(cache !== undefined ? { details: { cache } } : {}),
        artifacts: { lineage_ids: lineageIds },
      });
    } catch (err) {
      this.deps.logger.error({ err }, 'retrieval.served audit failed (alarm-and-continue, R0)');
    }
  }
}

/**
 * expires_at = min(now + ttl, token exp). The cache must never outlive the
 * delegated token behind it: once the token would be rejected by verify(), its
 * cached retrieval context must already be expired.
 */
function cacheExpiry(nowMs: number, ttlMs: number, tokenExpSec: number | undefined): number {
  const tokenExpMs = tokenExpSec !== undefined ? tokenExpSec * 1000 : Number.POSITIVE_INFINITY;
  return Math.min(nowMs + ttlMs, tokenExpMs);
}

/**
 * Classification access derives from delegated scopes: everyone with
 * corpus access reads public+internal; confidential requires its own
 * scope. Restricted material has no retrieval path in v0.
 */
export function allowedClassifications(scopes: string[]): string[] {
  const allowed = ['public', 'internal'];
  if (scopes.includes('knowledge:confidential:read')) allowed.push('confidential');
  return allowed;
}

function toResult(hit: SearchHit): SearchResult {
  return {
    content: hit.content,
    score: hit.score,
    citation: {
      doc_id: hit.doc_id,
      version: hit.doc_version,
      ...(hit.effective_date !== null ? { effective_date: hit.effective_date } : {}),
      ...(hit.url !== null ? { url: hit.url } : {}),
      lineage_id: hit.lineage_id,
      snippet: hit.content.slice(0, 240),
    },
  };
}
