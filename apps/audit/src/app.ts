import {
  AuthError,
  createHttpServer,
  scopesOf,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditStore } from './store.js';

export const AUDIT_AUDIENCE = 'acp:audit';

export interface AuditDeps {
  verifier: JwtVerifier;
  store: AuditStore;
  logger: Logger;
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

  return app;
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
