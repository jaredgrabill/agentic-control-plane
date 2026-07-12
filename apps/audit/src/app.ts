import {
  assertTenantAccess,
  AuthError,
  createHttpServer,
  scopesOf,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CHAIN_ALGORITHM,
  GENESIS_PREV_HASH,
  verifyChainPage,
  type ChainAnchor,
  type ChainFailure,
} from './chain.js';
import { reconstructTask } from './reconstruct.js';
import type { AuditStore } from './store.js';

export const AUDIT_AUDIENCE = 'acp:audit';
const VERIFY_PAGE = 1000;
/**
 * The hot-tier retention floor: six months. Audit records must be retained in
 * the hot store for at least this long — the EU AI Act Art.19 record-keeping
 * minimum. Boot REFUSES a configured value below it (fail-closed governance).
 */
export const RETENTION_FLOOR_DAYS = 183;

/**
 * Resolves the configured hot-tier retention (ACP_AUDIT_RETENTION_HOT_DAYS),
 * enforcing the six-month floor. Throws at boot on an invalid or sub-floor value
 * so a misconfiguration cannot silently shorten regulated retention.
 */
export function resolveRetentionHotDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return RETENTION_FLOOR_DAYS;
  const days = Number.parseInt(raw, 10);
  if (Number.isNaN(days) || days < 1) {
    throw new Error(
      `ACP_AUDIT_RETENTION_HOT_DAYS=${JSON.stringify(raw)} is not a positive integer number of days`,
    );
  }
  if (days < RETENTION_FLOOR_DAYS) {
    throw new Error(
      `ACP_AUDIT_RETENTION_HOT_DAYS=${days} is below the ${RETENTION_FLOOR_DAYS}-day floor ` +
        '(EU AI Act Art.19 six-month audit record-keeping minimum) — refusing to boot',
    );
  }
  return days;
}
/** Reconstruction caps the records it assembles; more than this sets `truncated`. */
const RECONSTRUCT_CAP = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuditDeps {
  verifier: JwtVerifier;
  store: AuditStore;
  logger: Logger;
  /** Hot-tier retention in days (>= RETENTION_FLOOR_DAYS); resolved at boot. */
  retentionHotDays?: number;
}

/** Provenance queries: the E2E "show me the delegation chain for this task" join. */
export function buildAuditApp(deps: AuditDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'audit', logger: deps.logger });

  app.get('/v1/events', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'audit:read');
    const q = request.query as {
      tenant?: string;
      task_id?: string;
      event_type?: string;
      since?: string;
      limit?: string;
    };
    if (q.tenant === undefined || q.tenant === '') {
      throw new AuthError('tenant query parameter is required', 400);
    }
    assertTenantAccess(claims, q.tenant);
    if (q.since !== undefined && Number.isNaN(Date.parse(q.since))) {
      throw new AuthError('since must be an ISO-8601 timestamp', 400);
    }
    const events = await deps.store.query({
      tenant: q.tenant,
      taskId: q.task_id,
      eventType: q.event_type,
      since: q.since,
      limit: q.limit === undefined ? undefined : Number.parseInt(q.limit, 10),
    });
    return { events };
  });

  /**
   * Integrity verification (D8). Walks the tenant's chain in 1000-row pages from
   * from_seq (default 1, anchored at genesis), recomputing each record hash and
   * checking sequence continuity + linkage. A pruned-prefix deployment verifies
   * the SUFFIX by passing from_seq + anchor_prev_hash (a recorded checkpoint) —
   * D9 soundness. The first failure stops the walk and is reported (never
   * written back to the possibly-tampered ledger — a tamper finding is an alarm).
   */
  app.get('/v1/verify', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'audit:read');
    const q = request.query as {
      tenant?: string;
      from_seq?: string;
      to_seq?: string;
      anchor_prev_hash?: string;
    };
    if (q.tenant === undefined || q.tenant === '') {
      throw new AuthError('tenant query parameter is required', 400);
    }
    assertTenantAccess(claims, q.tenant);
    const fromSeq = parsePositiveInt(q.from_seq, 'from_seq') ?? 1;
    const toSeq = parsePositiveInt(q.to_seq, 'to_seq');
    if (toSeq !== undefined && toSeq < fromSeq) {
      throw new AuthError('to_seq must be >= from_seq', 400);
    }
    // The anchor the first page's first row must present. Genesis unless the
    // caller is verifying a pruned suffix from a recorded checkpoint.
    const anchorPrevHash = q.anchor_prev_hash ?? GENESIS_PREV_HASH;
    if (fromSeq > 1 && q.anchor_prev_hash === undefined) {
      throw new AuthError(
        'anchor_prev_hash is required when from_seq > 1 — supply the recorded checkpoint hash so ' +
          'the suffix verifies against it (a pruned-prefix deployment records one at archival)',
        400,
      );
    }

    const head = await deps.store.chainHead(q.tenant);
    let anchor: ChainAnchor = { seq: fromSeq, prevHash: anchorPrevHash };
    let recordsChecked = 0;
    let failure: ChainFailure | undefined;

    for (;;) {
      const limit =
        toSeq === undefined ? VERIFY_PAGE : Math.min(VERIFY_PAGE, toSeq - anchor.seq + 1);
      if (limit <= 0) break;
      const rows = await deps.store.chainPage(q.tenant, anchor.seq, limit);
      if (rows.length === 0) break;
      const result = verifyChainPage(q.tenant, rows, anchor);
      if (result.ok) {
        recordsChecked += result.checked;
        anchor = result.anchor;
        if (rows.length < limit) break; // reached the end (or to_seq)
      } else {
        recordsChecked += result.checked;
        failure = result.failure;
        break;
      }
    }

    return {
      tenant: q.tenant,
      algorithm: CHAIN_ALGORITHM,
      verified: failure === undefined,
      records_checked: recordsChecked,
      head:
        head === undefined ? null : { chain_seq: head.chain_seq, record_hash: head.record_hash },
      ...(failure === undefined ? {} : { failure }),
    };
  });

  /**
   * Task reconstruction (D10): a forensic ASSEMBLY of one task from its audit
   * records in chain_seq order (the total order the chain bought) — submission,
   * plan, per-step dispatch/policy/approval/tokens/tool-calls/outcome, the
   * compensation unwind, and the terminal result. 404 when the task has no
   * records in the tenant; `truncated` at the record cap. Not re-execution.
   */
  app.get('/v1/tasks/:task_id/reconstruction', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'audit:read');
    const { task_id } = request.params as { task_id: string };
    if (!UUID_RE.test(task_id)) {
      throw new AuthError('task_id must be a uuid', 400);
    }
    const q = request.query as { tenant?: string };
    if (q.tenant === undefined || q.tenant === '') {
      throw new AuthError('tenant query parameter is required', 400);
    }
    assertTenantAccess(claims, q.tenant);
    // Fetch one past the cap to detect truncation.
    const rows = await deps.store.chainByTask(q.tenant, task_id, RECONSTRUCT_CAP + 1);
    if (rows.length === 0) {
      return reply.status(404).send({
        error: { message: `no task ${task_id} in tenant ${q.tenant}`, status: 404 },
      });
    }
    const truncated = rows.length > RECONSTRUCT_CAP;
    return reply.send(
      reconstructTask(task_id, q.tenant, rows.slice(0, RECONSTRUCT_CAP), truncated),
    );
  });

  // Retention policy surface (D9). The hot floor is enforced at boot; archival
  // and WORM tiers are deployment policy (see the audit-integrity runbook).
  app.get('/v1/retention', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'audit:read');
    return {
      hot_days: deps.retentionHotDays ?? RETENTION_FLOOR_DAYS,
      floor_days: RETENTION_FLOOR_DAYS,
      archival: 'deployment-policy',
      worm: 'deployment-policy',
      runbook: 'docs/runbooks/audit-integrity-and-retention.md',
    };
  });

  return app;
}

/** Parses an optional positive integer query param, or throws a 400. */
function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new AuthError(`${name} must be a positive integer`, 400);
  }
  return n;
}

async function authenticate(deps: AuditDeps, request: FastifyRequest): Promise<PlatformClaims> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  return deps.verifier.verify(header.slice('Bearer '.length), AUDIT_AUDIENCE);
}

function requireScope(claims: PlatformClaims, scope: string): void {
  if (!scopesOf(claims).includes(scope)) {
    throw new AuthError(`principal ${claims.sub} lacks scope ${scope}`, 403);
  }
}
