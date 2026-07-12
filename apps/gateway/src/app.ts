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
export const APPROVALS_DECIDE_SCOPE = 'approvals:decide';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Temporal is behind this seam so unit tests exercise the gateway without a cluster. */
export interface TaskStarter {
  start(request: TaskRequest): Promise<{ workflowRunId: string }>;
  status(
    tenant: string,
    taskId: string,
  ): Promise<{ status: 'running' | 'completed' | 'failed' | 'not_found'; result?: TaskResult }>;
  cancel(
    tenant: string,
    taskId: string,
  ): Promise<{ outcome: 'cancelling' | 'not_found' | 'already_terminal' }>;
}

/** The approver-facing view of a running (or just-closed) ApprovalWorkflow. */
export interface ApprovalView {
  status: 'pending' | 'granted' | 'denied' | 'timeout';
  subject: {
    approval_id: string;
    task_id: string;
    step_id: string;
    tenant: string;
    principal: string;
    agent_id: string;
    agent_version: string;
    capability: string;
    risk: string;
    input: Record<string, unknown>;
    requested_scopes: string[];
    compensator?: string;
    irreversible?: boolean;
    plan: unknown;
    plan_digest: string;
  };
  subject_digest: string;
  requested_at: string;
  escalated: boolean;
}

/** A verified human decision the gateway relays to the ApprovalWorkflow as a signal. */
export interface ApprovalDecisionInput {
  decision: 'approve' | 'deny';
  decision_id: string;
  approver: string;
  approver_chain: { sub: string }[];
  subject_digest: string;
  note?: string;
}

/**
 * Temporal-backed approval gate behind a seam. status() reads the running
 * workflow (source of truth, immune to audit lag) and treats a missing OR
 * cross-tenant workflow as absent; decide() relays the decision as a signal.
 */
export interface ApprovalGateway {
  status(approvalId: string, tenant: string): Promise<ApprovalView | undefined>;
  decide(approvalId: string, signal: ApprovalDecisionInput): Promise<void>;
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
  approvals: ApprovalGateway;
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

  // Cancel a running task (kill-switch drain, or an operator aborting a task).
  // Tenant-scoped by construction: a foreign task id reads as absent (404). A
  // terminal task is a 409. On success the task is NOT torn down — it drains
  // the in-flight wave, unwinds its compensation stack, and returns an honest
  // `cancelled` result the caller can still retrieve at GET /v1/tasks/:id.
  app.post('/v1/tasks/:task_id/cancel', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, TASK_SUBMIT_SCOPE);
    const { task_id } = request.params as { task_id: string };
    if (typeof task_id !== 'string' || !UUID_RE.test(task_id)) {
      throw new AuthError('task_id must be a uuid', 400);
    }
    const body = (request.body ?? {}) as { reason?: string };

    const result = await deps.starter.cancel(claims.tenant, task_id);
    if (result.outcome === 'not_found') {
      return reply
        .status(404)
        .send({ error: { message: `no task ${task_id} in tenant ${claims.tenant}`, status: 404 } });
    }
    if (result.outcome === 'already_terminal') {
      return reply.status(409).send({
        error: { message: `task ${task_id} is already terminal — nothing to cancel`, status: 409 },
      });
    }

    const span = trace.getActiveSpan();
    span?.setAttributes({ 'acp.tenant': claims.tenant, 'acp.task_id': task_id });

    // Audit the request from the VERIFIED caller (actor = claims.sub) — the
    // cancellation itself is attested even though the drain/unwind is the
    // workflow's own compensation.* records.
    await deps.audit.publish({
      event_id: randomUUID(),
      occurred_at: (deps.now?.() ?? new Date()).toISOString(),
      tenant: claims.tenant,
      event_type: 'task.cancel_requested',
      actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
      action: { name: 'task.cancel_requested' },
      reason: { task_id },
      artifacts: span !== undefined ? { trace_id: span.spanContext().traceId } : {},
      ...(body.reason === undefined ? {} : { details: { reason: body.reason } }),
    });

    return reply.status(202).send({ task_id, status: 'cancelling' });
  });

  // Full approval context for an approver to decide on: capability + risk,
  // agent@version, exact step input, scopes, compensator/irreversible, the
  // whole plan (blast radius), and the subject digest they must echo.
  app.get('/v1/approvals/:approval_id', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, APPROVALS_DECIDE_SCOPE);
    const approvalId = approvalIdParam(request);
    // Tenant-scoped by construction: a cross-tenant approval reads as absent.
    const view = await deps.approvals.status(approvalId, claims.tenant);
    if (view === undefined) {
      return reply.status(404).send({
        error: { message: `no approval ${approvalId} in tenant ${claims.tenant}`, status: 404 },
      });
    }
    return reply.send({
      approval_id: approvalId,
      status: view.status,
      subject: view.subject,
      subject_digest: view.subject_digest,
      requested_at: view.requested_at,
      escalated: view.escalated,
    });
  });

  app.post('/v1/approvals/:approval_id/decision', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, APPROVALS_DECIDE_SCOPE);
    const approvalId = approvalIdParam(request);
    const body = (request.body ?? {}) as {
      decision?: string;
      subject_digest?: string;
      note?: string;
    };
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      throw new AuthError('decision must be "approve" or "deny"', 400);
    }
    if (typeof body.subject_digest !== 'string' || body.subject_digest === '') {
      throw new AuthError(
        'subject_digest is required — echo the digest shown at GET /v1/approvals/:id so a stale ' +
          'context is refused',
        400,
      );
    }
    if (body.decision === 'deny' && (typeof body.note !== 'string' || body.note.trim() === '')) {
      throw new AuthError('a note is required when denying', 400);
    }

    const view = await deps.approvals.status(approvalId, claims.tenant);
    if (view === undefined) {
      return reply.status(404).send({
        error: { message: `no approval ${approvalId} in tenant ${claims.tenant}`, status: 404 },
      });
    }
    // Already decided (or timed out / closed): the first valid decision won.
    if (view.status !== 'pending') {
      return reply.status(409).send({
        error: { message: `approval ${approvalId} is already ${view.status}`, status: 409 },
      });
    }
    // Separation of duties: an approver may not approve their own delegation.
    // Enforced here AND independently re-checked inside the workflow.
    if (claims.sub === view.subject.principal) {
      return reply.status(403).send({
        error: {
          message:
            `separation of duties: ${claims.sub} is the subject of approval ${approvalId} ` +
            'and may not decide it',
          status: 403,
        },
      });
    }
    // Stale/forged context: the approver must echo the digest they were shown.
    if (body.subject_digest !== view.subject_digest) {
      return reply.status(409).send({
        error: {
          message:
            `stale approval context: the subject changed since it was shown (digest mismatch) ` +
            `for approval ${approvalId}`,
          status: 409,
        },
      });
    }

    const decisionId = randomUUID();
    const span = trace.getActiveSpan();
    span?.setAttributes({ 'acp.approval_id': approvalId, 'acp.decision': body.decision });

    // NO gateway-side audit: the workflow's approval.granted/denied IS the
    // record. Double-recording invites divergence. The workflow re-validates
    // the digest and self-approval independently before obeying.
    await deps.approvals.decide(approvalId, {
      decision: body.decision,
      decision_id: decisionId,
      approver: claims.sub,
      approver_chain: delegationChain(claims),
      subject_digest: body.subject_digest,
      ...(body.note === undefined ? {} : { note: body.note }),
    });

    return reply.status(202).send({ approval_id: approvalId, decision_id: decisionId });
  });

  return app;
}

/** Validates the approval id: it is interpolated into a workflow id, so a non-uuid is a 400. */
function approvalIdParam(request: FastifyRequest): string {
  const { approval_id } = request.params as { approval_id: string };
  if (typeof approval_id !== 'string' || !UUID_RE.test(approval_id)) {
    throw new AuthError('approval_id must be a uuid', 400);
  }
  return approval_id;
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
