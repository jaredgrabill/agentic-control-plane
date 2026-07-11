import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import {
  AuthError,
  createHttpServer,
  delegationChain,
  scopesOf,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthzRequest, CedarPdp, EntityRef } from './pdp.js';

export const POLICY_AUDIENCE = 'acp:policy';

export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

export interface PolicyDeps {
  verifier: JwtVerifier;
  pdp: CedarPdp;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

interface AuthorizeBody {
  principal?: EntityRef;
  action?: string;
  resource?: EntityRef;
  context?: Record<string, unknown>;
  /** Task attribution the PEP already holds; rides into the audit record. */
  reason?: { task_id?: string; step_id?: string; tenant?: string };
}

const ENTITY_TYPES = new Set(['User', 'Service', 'Agent', 'Corpus']);

export function buildPolicyApp(deps: PolicyDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'policy', logger: deps.logger });

  app.get('/v1/bundle', async (request) => {
    await authenticate(deps, request);
    return { version: deps.pdp.bundleVersion, policy_ids: deps.pdp.policyIds };
  });

  app.post('/v1/authorize', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'policy:decide');
    const body = (request.body ?? {}) as AuthorizeBody;
    const authz = validateBody(body);

    const decision = deps.pdp.authorize(authz);

    // Every governable action gets a decision AND a record. The decision
    // is returned regardless of audit outcome (R0 alarm-and-continue);
    // R1+ fail-closed enforcement composes at the PEP, which refuses to
    // act on an unaudited allow.
    try {
      await deps.audit.publish({
        event_id: randomUUID(),
        occurred_at: (deps.now?.() ?? new Date()).toISOString(),
        tenant: body.reason?.tenant ?? tenantOf(authz) ?? 'platform',
        event_type: 'policy.decision',
        actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
        action: {
          name: `${authz.action} (${authz.principal.type}::${authz.principal.id} → ${authz.resource.type}::${authz.resource.id})`,
        },
        reason: {
          ...(body.reason?.task_id !== undefined ? { task_id: body.reason.task_id } : {}),
          ...(body.reason?.step_id !== undefined ? { step_id: body.reason.step_id } : {}),
          policy: {
            decision: decision.decision,
            bundle_version: decision.bundle_version,
            determining_policies: decision.determining_policies,
          },
        },
      });
    } catch (err) {
      deps.logger.error({ err }, 'policy.decision audit publish failed (alarm-and-continue)');
    }

    return reply.send(decision);
  });

  return app;
}

function validateBody(body: AuthorizeBody): AuthzRequest {
  const principal = checkEntityRef('principal', body.principal);
  const resource = checkEntityRef('resource', body.resource);
  if (typeof body.action !== 'string' || body.action === '') {
    throw new AuthError('action is required (capability name or "delegate")', 400);
  }
  return { principal, action: body.action, resource, context: body.context };
}

function checkEntityRef(name: string, ref: EntityRef | undefined): EntityRef {
  if (ref === undefined || typeof ref.id !== 'string' || !ENTITY_TYPES.has(ref.type)) {
    throw new AuthError(`${name} must be {type: User|Service|Agent|Corpus, id, attrs?}`, 400);
  }
  return ref;
}

function tenantOf(authz: AuthzRequest): string | undefined {
  const t = authz.context?.tenant ?? authz.principal.attrs?.tenant;
  return typeof t === 'string' ? t : undefined;
}

async function authenticate(deps: PolicyDeps, request: FastifyRequest): Promise<PlatformClaims> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  return deps.verifier.verify(header.slice('Bearer '.length), POLICY_AUDIENCE);
}

function requireScope(claims: PlatformClaims, scope: string): void {
  if (!scopesOf(claims).includes(scope)) {
    throw new AuthError(`principal ${claims.sub} lacks scope ${scope}`, 403);
  }
}
