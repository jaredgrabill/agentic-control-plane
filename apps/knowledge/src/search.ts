import { randomUUID } from 'node:crypto';
import type { AuditEvent, Citation } from '@acp/protocol';
import {
  AuthError,
  delegationChain,
  scopesOf,
  sha256Digest,
  type JwtVerifier,
  type Logger,
} from '@acp/service-kit';
import type { Embedder } from './embedding.js';
import type { KnowledgeStore, SearchHit } from './store.js';

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

    const hits = await this.deps.store.search(
      this.deps.embedder.embed(request.query),
      request.query,
      Math.min(request.k ?? 8, 50),
      {
        tenant: claims.tenant,
        classifications: allowedClassifications(scopes),
        sourceId: request.source_id,
        mode: request.mode,
      },
    );

    // Retrieval events record the lineage_ids they served: "what exactly
    // did the agent read at that second" stays a join, not forensics.
    try {
      await this.deps.audit.publish({
        event_id: randomUUID(),
        occurred_at: (this.deps.now?.() ?? new Date()).toISOString(),
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
        artifacts: { lineage_ids: hits.map((h) => h.lineage_id) },
      });
    } catch (err) {
      this.deps.logger.error({ err }, 'retrieval.served audit failed (alarm-and-continue, R0)');
    }

    return hits.map(toResult);
  }
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
