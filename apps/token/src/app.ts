import formbody from '@fastify/formbody';
import type { AuditEvent } from '@acp/protocol';
import { AuthError, createHttpServer, delegationChain, type Logger } from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ClientRegistry, RegisteredClient } from './clients.js';
import type { KeyStore } from './keys.js';
import {
  TokenDeniedError,
  TokenIssuer,
  type IssuedToken,
  type KillSwitchLike,
  type TokenDenial,
} from './tokens.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** Non-standard on purpose: RFC 8693 requires a live subject token; the broker grant asserts a verified claim set (ADR-0007). */
export const BROKER_DELEGATION_GRANT = 'urn:acp:oauth:grant-type:broker-delegation';

/** Audit sink: the real one publishes to JetStream; tests observe events in memory. */
export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

export interface TokenAppDeps {
  keys: KeyStore;
  clients: ClientRegistry;
  issuer: string;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
  /** ADR-0007: broker grounds older than this are refused. Default 86400s. */
  brokerMaxTaskAgeSeconds?: number;
  /** ADR-0007 broker-time denylist: refuse mints for revoked identities. */
  killSwitch?: KillSwitchLike;
}

interface TokenBody {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  audience?: string;
  scope?: string;
  requested_ttl?: string;
  subject_token?: string;
  subject_token_type?: string;
  actor?: string;
  subject?: { sub?: string; tenant?: string; roles?: string[]; scopes?: string[] };
  grounds?: { task_id?: string; subject_jti?: string; verified_at?: string };
  /**
   * Human-approval grounds. Legal ONLY on the broker delegation grant — the
   * issue and exchange routes refuse a body-supplied approval so no client
   * can inject an approval claim into a token it mints for itself.
   */
  approval?: {
    approval_id?: string;
    decision_id?: string;
    approver?: string;
    step_id?: string;
    capability?: string;
    subject_digest?: string;
  };
  /**
   * Compensation grounds. Legal ONLY on the broker delegation grant — the
   * issue and exchange routes refuse a body-supplied compensation so no client
   * can inject a compensation claim into a token it mints for itself.
   */
  compensation?: {
    original_step_id?: string;
    original_capability?: string;
    approval_id?: string;
    approver?: string;
  };
  /**
   * Capability grounds. Legal ONLY on the broker delegation grant — the issue
   * and exchange routes refuse a body-supplied capability so no client can
   * forge the risk class its own token declares. The only legitimate source is
   * delegate(), which shape-validates name + risk.
   */
  capability?: {
    name?: string;
    risk?: string;
  };
  /**
   * Deployment grounds. Legal ONLY on the broker delegation grant — the issue
   * and exchange routes refuse a body-supplied deployment so no client can mint
   * itself a shadow token (which the tool gateway would then suppress writes
   * for — a caller-controlled shadow flag is a way to evade a write, not to
   * request one). The only legitimate source is delegate() from the
   * ShadowStepWorkflow.
   */
  deployment?: {
    mode?: string;
  };
}

export async function buildTokenApp(deps: TokenAppDeps): Promise<FastifyInstance> {
  const app = createHttpServer({ serviceName: 'token-service', logger: deps.logger });
  await app.register(formbody);
  const issuerSvc = new TokenIssuer(deps.keys, deps.issuer, {
    ...(deps.brokerMaxTaskAgeSeconds === undefined
      ? {}
      : { maxTaskAgeSeconds: deps.brokerMaxTaskAgeSeconds }),
    ...(deps.killSwitch === undefined ? {} : { killSwitch: deps.killSwitch }),
  });

  /**
   * Runs an issuer grant; if it is refused by the broker-time denylist,
   * emits a token.denied audit event before the 403 surfaces. The mint
   * already failed, so this is the security record of the refusal.
   */
  async function guarded<T>(
    grant: string,
    audience: string | undefined,
    client: RegisteredClient,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TokenDeniedError) {
        await emitDenied(deps, grant, audience ?? '', client, err.denial);
      }
      throw err;
    }
  }

  app.get('/.well-known/jwks.json', () => deps.keys.jwks);

  app.post('/v1/token', async (request, reply) => {
    const body = (request.body ?? {}) as TokenBody;
    const client = authenticateClient(deps.clients, request, body);
    if (body.grant_type !== 'client_credentials') {
      throw new AuthError(
        `unsupported grant_type ${JSON.stringify(body.grant_type ?? '')} — use client_credentials or POST /v1/token/exchange`,
        400,
      );
    }
    if (body.audience === undefined || body.audience === '') {
      throw new AuthError('audience is required — platform tokens are always audience-bound', 400);
    }
    rejectApproval(body, 'client_credentials issuance');
    rejectCompensation(body, 'client_credentials issuance');
    rejectCapability(body, 'client_credentials issuance');
    rejectDeployment(body, 'client_credentials issuance');
    const audience = body.audience;
    const issued = await guarded('client_credentials', audience, client, () =>
      issuerSvc.issue({
        client,
        audience,
        scopes: splitScope(body.scope),
        ttlSeconds: parseTtl(body.requested_ttl),
      }),
    );
    await emitAudit(deps, 'token.issued', client, issued);
    return reply.send(toResponse(issued));
  });

  app.post('/v1/token/exchange', async (request, reply) => {
    const body = (request.body ?? {}) as TokenBody;
    const client = authenticateClient(deps.clients, request, body);
    if (body.grant_type !== TOKEN_EXCHANGE_GRANT) {
      throw new AuthError(`grant_type must be ${TOKEN_EXCHANGE_GRANT}`, 400);
    }
    if (body.subject_token === undefined || body.subject_token === '') {
      throw new AuthError('subject_token is required', 400);
    }
    if (
      body.subject_token_type !== undefined &&
      body.subject_token_type !== 'urn:ietf:params:oauth:token-type:jwt'
    ) {
      throw new AuthError(
        `unsupported subject_token_type ${body.subject_token_type} — only urn:ietf:params:oauth:token-type:jwt`,
        400,
      );
    }
    if (body.audience === undefined || body.audience === '') {
      throw new AuthError('audience is required — exchange rebinds the token to its target', 400);
    }
    rejectApproval(body, 'token exchange');
    rejectCompensation(body, 'token exchange');
    rejectCapability(body, 'token exchange');
    rejectDeployment(body, 'token exchange');
    const audience = body.audience;
    const subjectToken = body.subject_token;
    const issued = await guarded(TOKEN_EXCHANGE_GRANT, audience, client, () =>
      issuerSvc.exchange({
        client,
        subjectToken,
        audience,
        scopes: splitScope(body.scope),
        actor: body.actor,
        ttlSeconds: parseTtl(body.requested_ttl),
      }),
    );
    await emitAudit(deps, 'token.exchanged', client, issued);
    return reply.send({
      ...toResponse(issued),
      issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
  });

  app.post('/v1/token/delegate', async (request, reply) => {
    const body = (request.body ?? {}) as TokenBody;
    const client = authenticateClient(deps.clients, request, body);
    if (body.grant_type !== BROKER_DELEGATION_GRANT) {
      throw new AuthError(`grant_type must be ${BROKER_DELEGATION_GRANT}`, 400);
    }
    if (body.audience === undefined || body.audience === '') {
      throw new AuthError('audience is required — brokered tokens are always audience-bound', 400);
    }
    if (body.scope === undefined) {
      throw new AuthError(
        'scope is required for the broker grant — send the target manifest tool bindings, ' +
          'or an empty string to request no scopes; the grant never defaults to the snapshot (ADR-0007)',
        400,
      );
    }
    if (body.subject === undefined || typeof body.subject !== 'object') {
      throw new AuthError('subject is required — the claim set verified at task intake', 400);
    }
    if (body.grounds?.task_id === undefined || body.grounds.task_id === '') {
      throw new AuthError('grounds.task_id is required — every mint must join to its task', 400);
    }
    if (body.grounds.verified_at === undefined || body.grounds.verified_at === '') {
      throw new AuthError(
        'grounds.verified_at is required — when the broker verified the subject token',
        400,
      );
    }
    const groundsTaskId = body.grounds.task_id;
    const groundsVerifiedAt = body.grounds.verified_at;
    const audience = body.audience;
    const issued = await guarded(BROKER_DELEGATION_GRANT, audience, client, () =>
      issuerSvc.delegate({
        client,
        subject: body.subject as { sub: string; tenant: string; roles: string[]; scopes: string[] },
        audience,
        // Explicit-or-nothing: an empty scope string means an empty grant,
        // never "everything the snapshot holds" (a toolless agent gets zero).
        scopes: splitScope(body.scope) ?? [],
        actor: body.actor,
        grounds: {
          task_id: groundsTaskId,
          ...(body.grounds?.subject_jti === undefined
            ? {}
            : { subject_jti: body.grounds.subject_jti }),
          verified_at: groundsVerifiedAt,
        },
        // Passed through verbatim; delegate() shape-validates every field and
        // refuses self-approval before it ever signs the claim.
        ...(body.approval === undefined
          ? {}
          : {
              approval: body.approval as NonNullable<
                Parameters<typeof issuerSvc.delegate>[0]['approval']
              >,
            }),
        // Passed through verbatim; delegate() shape-validates every field and
        // refuses an approval+compensation contradiction before it signs.
        ...(body.compensation === undefined
          ? {}
          : {
              compensation: body.compensation as NonNullable<
                Parameters<typeof issuerSvc.delegate>[0]['compensation']
              >,
            }),
        // Passed through verbatim; delegate() shape-validates name + risk
        // before it signs the capability claim the tool gateway enforces on.
        ...(body.capability === undefined
          ? {}
          : {
              capability: body.capability as NonNullable<
                Parameters<typeof issuerSvc.delegate>[0]['capability']
              >,
            }),
        // Deployment grounds — present only when the ShadowStepWorkflow brokers
        // a shadow step token. The token service shape-validates the mode before
        // it signs the deployment claim the tool gateway suppresses writes on.
        ...(body.deployment === undefined
          ? {}
          : {
              deployment: body.deployment as NonNullable<
                Parameters<typeof issuerSvc.delegate>[0]['deployment']
              >,
            }),
        ttlSeconds: parseTtl(body.requested_ttl),
      }),
    );
    await emitAudit(deps, 'token.brokered', client, issued, {
      reason: {
        task_id: body.grounds.task_id,
        ...(body.approval?.step_id === undefined
          ? body.compensation?.original_step_id === undefined
            ? {}
            : { step_id: body.compensation.original_step_id }
          : { step_id: body.approval.step_id }),
      },
      details: {
        ...(body.actor === undefined ? {} : { actor: body.actor }),
        grounds: body.grounds,
        // The approval grounds bound into the minted token — auditors see the
        // decision, decider, and subject digest that authorized this write.
        ...(body.approval === undefined ? {} : { approval: body.approval }),
        // The compensation grounds bound into a compensator's token — auditors
        // see which write this dispatch unwinds, and the approval that
        // pre-authorized it.
        ...(body.compensation === undefined ? {} : { compensation: body.compensation }),
        // The capability grounds bound into the token — auditors see the
        // executing capability and the risk class the tool gateway enforces on.
        ...(body.capability === undefined ? {} : { capability: body.capability }),
        // The deployment grounds bound into a shadow step token — auditors see
        // that this token's writes are suppressed at the tool gateway.
        ...(body.deployment === undefined ? {} : { deployment: body.deployment }),
      },
    });
    return reply.send({
      ...toResponse(issued),
      issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
  });

  return app;
}

function authenticateClient(
  clients: ClientRegistry,
  request: FastifyRequest,
  body: TokenBody,
): RegisteredClient {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ') === true) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) throw new AuthError('malformed Basic authorization header');
    return clients.authenticate(decoded.slice(0, sep), decoded.slice(sep + 1));
  }
  if (body.client_id !== undefined && body.client_secret !== undefined) {
    return clients.authenticate(body.client_id, body.client_secret);
  }
  throw new AuthError('client authentication required (Basic header or client_id/client_secret)');
}

/**
 * Approval grounds may ONLY be asserted on the broker delegation grant. A
 * body-supplied approval on the issue or exchange route is refused (400) so
 * no client can inject an approval claim into a token it mints for itself —
 * the only legitimate source is delegate(), which shape-validates it.
 */
function rejectApproval(body: TokenBody, grant: string): void {
  if (body.approval !== undefined) {
    throw new AuthError(
      `approval grounds are not accepted on ${grant} — only the broker delegation grant may ` +
        'assert an approval, and only after an ApprovalWorkflow granted it',
      400,
    );
  }
}

/**
 * Compensation grounds may ONLY be asserted on the broker delegation grant. A
 * body-supplied compensation on the issue or exchange route is refused (400)
 * so no client can forge a compensation claim into a token it mints for
 * itself — the only legitimate source is delegate() during a saga unwind.
 */
function rejectCompensation(body: TokenBody, grant: string): void {
  if (body.compensation !== undefined) {
    throw new AuthError(
      `compensation grounds are not accepted on ${grant} — only the broker delegation grant may ` +
        'assert a compensation, and only from the orchestrator unwind loop',
      400,
    );
  }
}

/**
 * Capability grounds may ONLY be asserted on the broker delegation grant. A
 * body-supplied capability on the issue or exchange route is refused (400) so
 * no client can forge the risk class its own token declares — the tool gateway
 * enforces risk from this exact claim, so a self-declared R0 on an R2 write
 * would launder the write. The only legitimate source is delegate().
 */
function rejectCapability(body: TokenBody, grant: string): void {
  if (body.capability !== undefined) {
    throw new AuthError(
      `capability grounds are not accepted on ${grant} — only the broker delegation grant may ` +
        'assert a capability, and only from the orchestrator dispatch',
      400,
    );
  }
}

/**
 * Deployment grounds may ONLY be asserted on the broker delegation grant. A
 * body-supplied deployment on the issue or exchange route is refused (400) so
 * no client can mint itself a shadow token — the tool gateway suppresses side
 * effects for a shadow token, so a caller-controlled shadow flag is a way to
 * make a write vanish, not to request one. The only legitimate source is
 * delegate() from the ShadowStepWorkflow.
 */
function rejectDeployment(body: TokenBody, grant: string): void {
  if (body.deployment !== undefined) {
    throw new AuthError(
      `deployment grounds are not accepted on ${grant} — only the broker delegation grant may ` +
        'assert a deployment, and only from the orchestrator shadow-step workflow',
      400,
    );
  }
}

function splitScope(scope: string | undefined): string[] | undefined {
  if (scope === undefined || scope.trim() === '') return undefined;
  return scope.trim().split(/\s+/);
}

function parseTtl(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n))
    throw new AuthError('requested_ttl must be an integer number of seconds', 400);
  return n;
}

function toResponse(issued: IssuedToken): Record<string, unknown> {
  return {
    access_token: issued.token,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    scope: issued.claims.scope,
  };
}

/**
 * Records a broker-time denial (ADR-0007). Emitted after the mint was
 * already refused, so the caller gets its 403 regardless; this is the audit
 * record of the refusal. R0 fail-open-with-alarm like the other token
 * audits — the denial itself is enforced at mint time, not by this write.
 */
async function emitDenied(
  deps: TokenAppDeps,
  grant: string,
  audience: string,
  client: RegisteredClient,
  denial: TokenDenial,
): Promise<void> {
  const event: AuditEvent = {
    event_id: crypto.randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    tenant: denial.tenant,
    event_type: 'token.denied',
    actor: {
      principal: client.principal,
      delegation_chain: [{ sub: client.principal }],
    },
    action: { name: 'token.denied' },
    details: {
      grant,
      audience,
      reason: denial.reason,
      key: denial.key,
      principal: denial.principal,
    },
  };
  try {
    await deps.audit.publish(event);
  } catch (err) {
    deps.logger.error(
      { err, reason: denial.reason, key: denial.key },
      'token.denied audit publish failed (fail-open, R0 tier) — the denial itself was enforced',
    );
  }
}

async function emitAudit(
  deps: TokenAppDeps,
  eventType: 'token.issued' | 'token.exchanged' | 'token.brokered',
  client: RegisteredClient,
  issued: IssuedToken,
  extra?: { reason?: AuditEvent['reason']; details?: Record<string, unknown> },
): Promise<void> {
  const event: AuditEvent = {
    event_id: crypto.randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    tenant: issued.claims.tenant,
    event_type: eventType,
    actor: {
      principal: client.principal,
      delegation_chain: delegationChain(issued.claims),
    },
    action: { name: eventType },
    ...(extra?.reason === undefined ? {} : { reason: extra.reason }),
    details: {
      audience: issued.claims.aud,
      scope: issued.claims.scope,
      subject: issued.claims.sub,
      ...extra?.details,
    },
  };
  try {
    await deps.audit.publish(event);
  } catch (err) {
    // Token issuance is availability-critical; R0-tier fail-open-with-alarm
    // (governance-and-policy.md) — the alarm is this error log + the
    // stream's own monitoring, and R1+ paths get fail-closed treatment at
    // the tool gateway, not here.
    deps.logger.error({ err, event_type: eventType }, 'audit publish failed (fail-open, R0 tier)');
  }
}
