import formbody from '@fastify/formbody';
import type { AuditEvent } from '@acp/protocol';
import { AuthError, createHttpServer, delegationChain, type Logger } from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ClientRegistry, RegisteredClient } from './clients.js';
import type { KeyStore } from './keys.js';
import { TokenIssuer, type IssuedToken } from './tokens.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

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
}

export async function buildTokenApp(deps: TokenAppDeps): Promise<FastifyInstance> {
  const app = createHttpServer({ serviceName: 'token-service', logger: deps.logger });
  await app.register(formbody);
  const issuerSvc = new TokenIssuer(deps.keys, deps.issuer);

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
    const issued = await issuerSvc.issue({
      client,
      audience: body.audience,
      scopes: splitScope(body.scope),
      ttlSeconds: parseTtl(body.requested_ttl),
    });
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
    const issued = await issuerSvc.exchange({
      client,
      subjectToken: body.subject_token,
      audience: body.audience,
      scopes: splitScope(body.scope),
      actor: body.actor,
      ttlSeconds: parseTtl(body.requested_ttl),
    });
    await emitAudit(deps, 'token.exchanged', client, issued);
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

async function emitAudit(
  deps: TokenAppDeps,
  eventType: 'token.issued' | 'token.exchanged',
  client: RegisteredClient,
  issued: IssuedToken,
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
    details: {
      audience: issued.claims.aud,
      scope: issued.claims.scope,
      subject: issued.claims.sub,
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
