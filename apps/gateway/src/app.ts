import { randomUUID } from 'node:crypto';
import { taskRequest, type AuditEvent, type TaskRequest, type TaskResult } from '@acp/protocol';
import {
  AuthError,
  createHttpServer,
  delegationChain,
  scopesOf,
  sha256Digest,
  type JwtVerifier,
  type KillSwitchState,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import { trace } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const GATEWAY_AUDIENCE = 'acp:gateway';
export const TASK_SUBMIT_SCOPE = 'task:submit';

/** Temporal is behind this seam so unit tests exercise the gateway without a cluster. */
export interface TaskStarter {
  start(request: TaskRequest): Promise<{ workflowRunId: string }>;
  status(
    tenant: string,
    taskId: string,
  ): Promise<{ status: 'running' | 'completed' | 'failed' | 'not_found'; result?: TaskResult }>;
}

export interface KillSwitchReader {
  fleetHalt(): KillSwitchState | undefined;
}

export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

export interface GatewayDeps {
  verifier: JwtVerifier;
  starter: TaskStarter;
  killSwitch: KillSwitchReader;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

interface SubmitBody {
  text?: string;
  capability?: string;
  context?: Record<string, unknown>;
  session_id?: string;
  budget?: { max_tokens?: number; max_steps?: number; max_cost_usd?: number };
}

export function buildGatewayApp(deps: GatewayDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'gateway', logger: deps.logger });

  app.post('/v1/tasks', async (request, reply) => {
    const { claims, token } = await authenticateReturningToken(deps, request);
    requireScope(claims, TASK_SUBMIT_SCOPE);

    const halt = deps.killSwitch.fleetHalt();
    if (halt !== undefined) {
      return reply.status(503).send({
        error: {
          message: `task intake halted by fleet kill switch: ${halt.reason ?? 'no reason recorded'}`,
          status: 503,
        },
      });
    }

    const body = (request.body ?? {}) as SubmitBody;
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      throw new AuthError('task text is required', 400);
    }

    // Attribution is stamped here, from the verified token — clients cannot
    // claim a tenant or principal they did not authenticate as.
    const task: TaskRequest = taskRequest.parse({
      kind: 'task_request',
      task_id: randomUUID(),
      tenant: claims.tenant,
      principal: claims.sub,
      session_id: body.session_id ?? randomUUID(),
      input: {
        text: body.text,
        ...(body.capability !== undefined ? { capability: body.capability } : {}),
        ...(body.context !== undefined ? { context: body.context } : {}),
      },
      ...(body.budget !== undefined ? { budget: body.budget } : {}),
      // Forwarded for RFC 8693 exchange at each delegation hop; its ≤15min
      // TTL bounds how long it lives in workflow state.
      subject_token: token,
      submitted_at: (deps.now?.() ?? new Date()).toISOString(),
    });

    const span = trace.getActiveSpan();
    span?.setAttributes({
      'acp.tenant': task.tenant,
      'acp.task_id': task.task_id,
      'acp.principal': task.principal,
    });

    const { workflowRunId } = await deps.starter.start(task);

    // Audit before responding: if this publish fails the task still ran,
    // which is exactly the R1+ fail-closed debate — task submission is R0
    // (read intake), so alarm-and-continue would also be defensible; being
    // strict here costs one ack round-trip and keeps intake fully attested.
    await deps.audit.publish({
      event_id: randomUUID(),
      occurred_at: (deps.now?.() ?? new Date()).toISOString(),
      tenant: task.tenant,
      event_type: 'task.submitted',
      actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
      action: { name: 'task.submitted', inputs_digest: sha256Digest(task.input.text) },
      reason: { task_id: task.task_id },
      artifacts: {
        workflow_run_id: workflowRunId,
        ...(span !== undefined ? { trace_id: span.spanContext().traceId } : {}),
      },
    });

    return reply.status(202).send({
      task_id: task.task_id,
      session_id: task.session_id,
      workflow_run_id: workflowRunId,
    });
  });

  app.get('/v1/tasks/:task_id', async (request, reply) => {
    const claims = await authenticate(deps, request);
    const { task_id } = request.params as { task_id: string };
    // Status lookups are tenant-scoped by construction: the lookup key
    // embeds the caller's own tenant, so foreign task IDs read as absent.
    const status = await deps.starter.status(claims.tenant, task_id);
    if (status.status === 'not_found') {
      return reply
        .status(404)
        .send({ error: { message: `no task ${task_id} in tenant ${claims.tenant}`, status: 404 } });
    }
    return reply.send({ task_id, status: status.status, result: status.result ?? null });
  });

  return app;
}

async function authenticate(deps: GatewayDeps, request: FastifyRequest): Promise<PlatformClaims> {
  const claims = await authenticateReturningToken(deps, request);
  return claims.claims;
}

async function authenticateReturningToken(
  deps: GatewayDeps,
  request: FastifyRequest,
): Promise<{ claims: PlatformClaims; token: string }> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  const token = header.slice('Bearer '.length);
  return { claims: await deps.verifier.verify(token, GATEWAY_AUDIENCE), token };
}

function requireScope(claims: PlatformClaims, scope: string): void {
  if (!scopesOf(claims).includes(scope)) {
    throw new AuthError(
      `principal ${claims.sub} lacks scope ${scope} — request it at token issuance`,
      403,
    );
  }
}
