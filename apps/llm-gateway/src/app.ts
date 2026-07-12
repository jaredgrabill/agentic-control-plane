/**
 * The HTTP door: POST /v1/complete and GET /v1/model-classes.
 *
 * Order per request: missing/invalid Bearer (or a service token without
 * llm:invoke, or an agent audience whose actor does not match) → 401
 * `unauthenticated`; a body that fails the wire schema → 400
 * `invalid_input`; everything after that is the core's typed
 * `{error: {class, …}}` vocabulary. Correlation headers are
 * UUID-validated or dropped — audit joins must never be poisoned by
 * caller-controlled junk — and body metadata wins over headers.
 */

import { AuthError, createHttpServer, type JwtVerifier, type Logger } from '@acp/service-kit';
import { completionRequest, type CompletionRequest, type LlmErrorBody } from '@acp/llm-client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { acceptLlmAudience, AUDIENCE_DESCRIPTION, resolveCaller, type Caller } from './caller.js';
import type { Correlation, LlmGatewayCore } from './core.js';

export interface LlmGatewayAppDeps {
  core: LlmGatewayCore;
  verifier: JwtVerifier;
  logger: Logger;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildLlmGatewayApp(deps: LlmGatewayAppDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'llm-gateway', logger: deps.logger });

  // The gateway speaks ONE error shape: {error: {class, message, status}}.
  // Re-handle what service-kit's default would emit without a class.
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AuthError) {
      return reply.status(error.statusCode).send({
        error: { class: 'unauthenticated', message: error.message, status: error.statusCode },
      } satisfies LlmErrorBody);
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      deps.logger.error({ err, path: request.url }, 'request failed');
      return reply.status(status).send({
        error: { class: 'unavailable', message: 'internal error', status },
      } satisfies LlmErrorBody);
    }
    // Fastify body-parse failures and other client-side 4xx.
    return reply.status(status).send({
      error: { class: 'invalid_input', message: err.message, status },
    } satisfies LlmErrorBody);
  });

  app.post('/v1/complete', async (request, reply) => {
    const caller = await authenticate(deps, request);
    const corr = correlationOf(request);

    const violations = completionRequest.errors(request.body);
    if (violations.length > 0) {
      return reply.status(400).send({
        error: {
          class: 'invalid_input',
          message: `invalid completion request: ${violations.slice(0, 3).join('; ')}`,
          status: 400,
        },
      } satisfies LlmErrorBody);
    }

    const result = await deps.core.complete(caller, request.body as CompletionRequest, corr);
    return reply.status(result.status).send(result.body);
  });

  app.get('/v1/model-classes', async (request, reply) => {
    await authenticate(deps, request);
    return reply.send(deps.core.modelClasses());
  });

  return app;
}

async function authenticate(deps: LlmGatewayAppDeps, request: FastifyRequest): Promise<Caller> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  const token = header.slice('Bearer '.length);
  const claims = await deps.verifier.verifyWithAudience(
    token,
    acceptLlmAudience,
    AUDIENCE_DESCRIPTION,
  );
  return resolveCaller(claims);
}

export function correlationOf(request: FastifyRequest): Correlation {
  return {
    taskId: uuidHeader(request, 'x-acp-task-id'),
    stepId: uuidHeader(request, 'x-acp-step-id'),
  };
}

function uuidHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !UUID_PATTERN.test(value)) return undefined;
  return value;
}
