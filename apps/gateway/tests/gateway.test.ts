import type { AuditEvent, TaskRequest, TaskResult } from '@acp/protocol';
import { JwtVerifier, createLogger, initTelemetry, type KillSwitchState } from '@acp/service-kit';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildGatewayApp,
  GATEWAY_AUDIENCE,
  type ApprovalDecisionInput,
  type ApprovalView,
  type DeploymentController,
  type DeploymentStartInput,
  type DeploymentStatusView,
} from '../src/app.js';
import { taskWorkflowId } from '../src/temporal.js';

const ISSUER = 'https://token.test.local';

let app: FastifyInstance;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicJwk: JWK;

const started: TaskRequest[] = [];
const auditEvents: AuditEvent[] = [];
let fleetHalt: KillSwitchState | undefined;
/** Tenants with an active per-tenant halt (the stubbed kill-switch read side). */
const haltedTenants = new Map<string, KillSwitchState>();
let statusResponse: Awaited<ReturnType<Parameters<typeof buildGatewayApp>[0]['starter']['status']>>;
let cancelResponse: Awaited<ReturnType<Parameters<typeof buildGatewayApp>[0]['starter']['cancel']>>;
const cancelCalls: { tenant: string; taskId: string }[] = [];

const APPROVAL_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90';
const SUBJECT_DIGEST = `sha256:${'a'.repeat(64)}`;
let approvalView: ApprovalView | undefined;
const decideCalls: { approvalId: string; signal: ApprovalDecisionInput }[] = [];

const deployStarts: DeploymentStartInput[] = [];
let deployStartResult: Awaited<ReturnType<DeploymentController['start']>>;
let deployStatusResponse: DeploymentStatusView | undefined;
let deployAbortResult: Awaited<ReturnType<DeploymentController['abort']>>;

function makeApprovalView(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    status: 'pending',
    subject: {
      approval_id: APPROVAL_ID,
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
      tenant: 'acme',
      principal: 'user:jane.doe',
      agent_id: 'gov-agent',
      agent_version: '0.1.0',
      capability: 'gov.test_write',
      risk: 'R2',
      input: { target: 'record-42' },
      requested_scopes: ['gov:test:write'],
      compensator: 'gov.test_undo',
      plan: { plan_id: 'p', steps: [] },
      plan_digest: `sha256:${'0'.repeat(64)}`,
    },
    subject_digest: SUBJECT_DIGEST,
    requested_at: '2026-07-11T09:00:10Z',
    escalated: false,
    ...over,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);

  app = buildGatewayApp({
    verifier: new JwtVerifier({ jwks: { keys: [{ ...publicJwk, alg: 'EdDSA' }] } }, ISSUER),
    starter: {
      start: (req) => {
        started.push(req);
        return Promise.resolve({ workflowRunId: `run-${req.task_id}` });
      },
      status: () => Promise.resolve(statusResponse),
      cancel: (tenant, taskId) => {
        cancelCalls.push({ tenant, taskId });
        return Promise.resolve(cancelResponse);
      },
    },
    approvals: {
      // Mirrors TemporalApprovalGateway: cross-tenant reads as absent.
      status: (_id, tenant) =>
        Promise.resolve(approvalView?.subject.tenant === tenant ? approvalView : undefined),
      decide: (approvalId, signal) => {
        decideCalls.push({ approvalId, signal });
        return Promise.resolve();
      },
    },
    deployments: {
      start: (input) => {
        deployStarts.push(input);
        return Promise.resolve(deployStartResult);
      },
      status: () => Promise.resolve(deployStatusResponse),
      abort: () => Promise.resolve(deployAbortResult),
    },
    killSwitch: { fleetHalt: () => fleetHalt, tenantHalt: (t) => haltedTenants.get(t) },
    audit: {
      publish: (e) => {
        auditEvents.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('gateway-test'),
  });
});

beforeEach(() => {
  started.length = 0;
  auditEvents.length = 0;
  fleetHalt = undefined;
  haltedTenants.clear();
  statusResponse = { status: 'running' };
  cancelResponse = { outcome: 'cancelling' };
  cancelCalls.length = 0;
  deployStarts.length = 0;
  deployStartResult = { outcome: 'started', workflowRunId: 'deploy-run-1' };
  deployStatusResponse = {
    deployment_id: 'd1',
    phase: 'canary',
    aborted: false,
    gate_reports: [],
    running: true,
  };
  deployAbortResult = { outcome: 'aborting' };
  approvalView = makeApprovalView();
  decideCalls.length = 0;
});

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: 'task:submit',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience((overrides.aud as string | undefined) ?? GATEWAY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function submit(token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

const QUESTION = 'What does our policy say about change freezes?';

describe('POST /v1/tasks', () => {
  it('authenticates, stamps attribution from the token, and starts the workflow', async () => {
    const res = await submit(await makeToken(), {
      text: QUESTION,
      capability: 'knowledge.answer_with_citations',
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ task_id: string; workflow_run_id: string }>();
    expect(body.workflow_run_id).toBe(`run-${body.task_id}`);

    expect(started).toHaveLength(1);
    const task = started[0]!;
    // Attribution comes from the verified token, not the request body.
    expect(task.tenant).toBe('acme');
    expect(task.principal).toBe('user:jane.doe');
    expect(task.input.capability).toBe('knowledge.answer_with_citations');
    // The caller's token rides along for RFC 8693 exchange at delegation.
    expect(task.subject_token).toBeTruthy();
  });

  it('carries session, context, and budget through to the task contract', async () => {
    const res = await submit(await makeToken(), {
      text: QUESTION,
      session_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
      context: { channel: 'chatops' },
      budget: { max_tokens: 5000, max_steps: 2 },
    });
    expect(res.statusCode).toBe(202);
    const task = started[0]!;
    expect(task.session_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41');
    expect(task.input.context).toEqual({ channel: 'chatops' });
    expect(task.budget).toEqual({ max_tokens: 5000, max_steps: 2 });
  });

  it('ignores caller attempts to spoof attribution in the body', async () => {
    const res = await submit(await makeToken(), {
      text: QUESTION,
      tenant: 'other-tenant',
      principal: 'user:admin',
    });
    expect(res.statusCode).toBe(202);
    expect(started[0]!.tenant).toBe('acme');
    expect(started[0]!.principal).toBe('user:jane.doe');
  });

  it('rejects missing, unsigned, wrong-audience, and expired tokens', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/v1/tasks', payload: { text: 'x' } });
    expect(noAuth.statusCode).toBe(401);

    const wrongAud = await submit(await makeToken({ aud: 'acp:other' }), { text: 'x' });
    expect(wrongAud.statusCode).toBe(401);

    const forged = await submit('for.ged.token', { text: 'x' });
    expect(forged.statusCode).toBe(401);

    expect(started).toHaveLength(0);
  });

  it('rejects tokens without task:submit scope', async () => {
    const res = await submit(await makeToken({ scope: 'knowledge:search:read' }), { text: 'x' });
    expect(res.statusCode).toBe(403);
    expect(started).toHaveLength(0);
  });

  it('rejects an empty task text', async () => {
    const res = await submit(await makeToken(), { text: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 while the fleet kill switch is active and recovers when cleared', async () => {
    fleetHalt = { active: true, reason: 'game day drill' };
    const halted = await submit(await makeToken(), { text: QUESTION });
    expect(halted.statusCode).toBe(503);
    expect(halted.json<{ error: { message: string } }>().error.message).toContain('game day');
    expect(started).toHaveLength(0);

    fleetHalt = undefined;
    const recovered = await submit(await makeToken(), { text: QUESTION });
    expect(recovered.statusCode).toBe(202);
  });

  it('503s intake for a HALTED tenant only, keyed by the verified token tenant', async () => {
    haltedTenants.set('acme', { active: true, reason: 'tenant incident' });

    // The halted tenant's caller is refused — the tenant comes from the
    // verified token; a body-supplied tenant cannot dodge the halt.
    const halted = await submit(await makeToken(), { text: QUESTION, tenant: 'globex' });
    expect(halted.statusCode).toBe(503);
    expect(halted.json<{ error: { message: string } }>().error.message).toContain(
      'tenant acme',
    );
    expect(started).toHaveLength(0);

    // Another tenant's caller is untouched by acme's halt.
    const other = await submit(await makeToken({ tenant: 'globex' }), { text: QUESTION });
    expect(other.statusCode).toBe(202);
    expect(started[0]!.tenant).toBe('globex');

    // Resume → acme intake recovers.
    haltedTenants.clear();
    const recovered = await submit(await makeToken(), { text: QUESTION });
    expect(recovered.statusCode).toBe(202);
  });

  it('emits task.submitted audit with the delegation chain and input digest', async () => {
    await submit(await makeToken(), { text: QUESTION });
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.event_type).toBe('task.submitted');
    expect(event.tenant).toBe('acme');
    expect(event.actor.delegation_chain).toEqual([{ sub: 'user:jane.doe' }]);
    expect(event.action.inputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.reason?.task_id).toBe(started[0]!.task_id);
  });

  it('stamps acp.* span attributes and the trace_id into audit when a trace is active', async () => {
    initTelemetry('gateway-test', {
      spanProcessor: new SimpleSpanProcessor(new InMemorySpanExporter()),
    });
    const tracer = trace.getTracer('gateway-test');
    const token = await makeToken();
    await tracer.startActiveSpan('test-submit', async (span) => {
      await submit(token, { text: QUESTION });
      span.end();
    });
    expect(auditEvents[0]!.artifacts?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a bodyless submission and reports a fleet halt without a recorded reason', async () => {
    const noBody = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(noBody.statusCode).toBe(400);

    fleetHalt = { active: true };
    const halted = await submit(await makeToken(), { text: QUESTION });
    expect(halted.statusCode).toBe(503);
    expect(halted.json<{ error: { message: string } }>().error.message).toContain(
      'no reason recorded',
    );
  });

  it('fails the submission when the audit stream will not acknowledge intake', async () => {
    const strictApp = buildGatewayApp({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...publicJwk, alg: 'EdDSA' }] } }, ISSUER),
      starter: {
        start: () => Promise.resolve({ workflowRunId: 'run-x' }),
        status: () => Promise.resolve({ status: 'running' as const }),
        cancel: () => Promise.resolve({ outcome: 'cancelling' as const }),
      },
      approvals: {
        status: () => Promise.resolve(undefined),
        decide: () => Promise.resolve(),
      },
      deployments: {
        start: () => Promise.resolve({ outcome: 'started', workflowRunId: 'r' }),
        status: () => Promise.resolve(undefined),
        abort: () => Promise.resolve({ outcome: 'not_found' }),
      },
      killSwitch: { fleetHalt: () => undefined, tenantHalt: () => undefined },
      audit: { publish: () => Promise.reject(new Error('stream down')) },
      logger: createLogger('gateway-test'),
    });
    const res = await strictApp.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { authorization: `Bearer ${await makeToken()}` },
      payload: { text: QUESTION },
    });
    expect(res.statusCode).toBe(500);
  });
});

describe('GET /v1/tasks/:task_id', () => {
  it('returns running status', async () => {
    const res = await app.inject({
      url: '/v1/tasks/abc',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('running');
  });

  it('returns the result once completed', async () => {
    const result: TaskResult = {
      kind: 'task_result',
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      tenant: 'acme',
      status: 'completed',
      answer: { text: 'answer [1]', citations: [], confidence: 0.9 },
    };
    statusResponse = { status: 'completed', result };
    const res = await app.inject({
      url: '/v1/tasks/0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.json<{ result: TaskResult }>().result.answer?.text).toBe('answer [1]');
  });

  it('404s for unknown tasks and requires auth', async () => {
    statusResponse = { status: 'not_found' };
    const missing = await app.inject({
      url: '/v1/tasks/nope',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(missing.statusCode).toBe(404);

    const unauthed = await app.inject({ url: '/v1/tasks/nope' });
    expect(unauthed.statusCode).toBe(401);
  });
});

describe('POST /v1/tasks/:task_id/cancel', () => {
  const TASK = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
  const cancel = async (token: string, taskId = TASK, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  it('202s, calls the tenant-scoped starter, and audits task.cancel_requested', async () => {
    cancelResponse = { outcome: 'cancelling' };
    const res = await cancel(await makeToken(), TASK, { reason: 'kill switch drill' });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ status: string }>().status).toBe('cancelling');
    expect(cancelCalls).toEqual([{ tenant: 'acme', taskId: TASK }]);
    const event = auditEvents.find((e) => e.event_type === 'task.cancel_requested');
    expect(event).toBeDefined();
    expect(event!.actor.principal).toBe('user:jane.doe');
    expect((event!.details as { reason: string }).reason).toBe('kill switch drill');
    expect(event!.reason?.task_id).toBe(TASK);
  });

  it('404s for an unknown OR cross-tenant task (reads as absent), with no audit', async () => {
    cancelResponse = { outcome: 'not_found' };
    const res = await cancel(await makeToken());
    expect(res.statusCode).toBe(404);
    expect(auditEvents.some((e) => e.event_type === 'task.cancel_requested')).toBe(false);
  });

  it('409s for an already-terminal task', async () => {
    cancelResponse = { outcome: 'already_terminal' };
    const res = await cancel(await makeToken());
    expect(res.statusCode).toBe(409);
  });

  it('403s without the task:submit scope', async () => {
    const res = await cancel(await makeToken({ scope: 'audit:read' }));
    expect(res.statusCode).toBe(403);
    expect(cancelCalls).toHaveLength(0);
  });

  it('400s for a non-uuid task id and 401s without auth', async () => {
    const bad = await cancel(await makeToken(), 'not-a-uuid');
    expect(bad.statusCode).toBe(400);
    const unauthed = await app.inject({ method: 'POST', url: `/v1/tasks/${TASK}/cancel` });
    expect(unauthed.statusCode).toBe(401);
  });
});

describe('taskWorkflowId', () => {
  it('is tenant-scoped so lookups cannot cross tenants', () => {
    expect(taskWorkflowId('acme', 'abc')).toBe('task-acme-abc');
    expect(taskWorkflowId('acme', 'abc')).not.toBe(taskWorkflowId('globex', 'abc'));
  });
});

describe('approval API', () => {
  const APPROVER_SUB = 'user:approver.ops';
  async function approverToken(scope = 'approvals:decide'): Promise<string> {
    return makeToken({ sub: APPROVER_SUB, scope });
  }
  async function getApproval(token: string, id = APPROVAL_ID) {
    return app.inject({
      method: 'GET',
      url: `/v1/approvals/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }
  async function decide(token: string, body: Record<string, unknown>, id = APPROVAL_ID) {
    return app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}/decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  describe('GET /v1/approvals/:id', () => {
    it('returns the full context to a scoped approver', async () => {
      const res = await getApproval(await approverToken());
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        subject: { plan: unknown; capability: string };
        subject_digest: string;
      }>();
      expect(body.subject.capability).toBe('gov.test_write');
      expect(body.subject.plan).toBeDefined();
      expect(body.subject_digest).toBe(SUBJECT_DIGEST);
    });

    it('401 without a token, 403 without the approvals:decide scope', async () => {
      const anon = await app.inject({ method: 'GET', url: `/v1/approvals/${APPROVAL_ID}` });
      expect(anon.statusCode).toBe(401);
      const wrongScope = await getApproval(await approverToken('task:submit'));
      expect(wrongScope.statusCode).toBe(403);
    });

    it('404 for a cross-tenant approval (reads as absent)', async () => {
      approvalView = makeApprovalView({
        subject: { ...makeApprovalView().subject, tenant: 'globex', principal: 'user:eve' },
      });
      const res = await getApproval(await approverToken());
      expect(res.statusCode).toBe(404);
    });

    it('404 for an unknown approval', async () => {
      approvalView = undefined;
      const res = await getApproval(await approverToken());
      expect(res.statusCode).toBe(404);
    });

    it('400 for a non-uuid approval id', async () => {
      const res = await getApproval(await approverToken(), 'not-a-uuid');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/approvals/:id/decision', () => {
    it('approves: signals the workflow and returns 202 with a decision id, no gateway audit', async () => {
      const res = await decide(await approverToken(), {
        decision: 'approve',
        subject_digest: SUBJECT_DIGEST,
      });
      expect(res.statusCode).toBe(202);
      const body = res.json<{ approval_id: string; decision_id: string }>();
      expect(body.approval_id).toBe(APPROVAL_ID);
      expect(body.decision_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(decideCalls).toHaveLength(1);
      const { signal } = decideCalls[0]!;
      expect(signal).toMatchObject({
        decision: 'approve',
        approver: APPROVER_SUB,
        subject_digest: SUBJECT_DIGEST,
      });
      expect(signal.approver_chain[0]!.sub).toBe(APPROVER_SUB);
      // The workflow's approval.granted is the record — the gateway emits none.
      expect(auditEvents).toHaveLength(0);
    });

    it('denies with a mandatory note', async () => {
      const res = await decide(await approverToken(), {
        decision: 'deny',
        subject_digest: SUBJECT_DIGEST,
        note: 'blast radius too wide',
      });
      expect(res.statusCode).toBe(202);
      expect(decideCalls[0]!.signal.decision).toBe('deny');
    });

    it('403 without the approvals:decide scope', async () => {
      const res = await decide(await approverToken('task:submit'), {
        decision: 'approve',
        subject_digest: SUBJECT_DIGEST,
      });
      expect(res.statusCode).toBe(403);
      expect(decideCalls).toHaveLength(0);
    });

    it('400 for a bad decision value or a missing subject_digest', async () => {
      expect(
        (await decide(await approverToken(), { decision: 'maybe', subject_digest: SUBJECT_DIGEST }))
          .statusCode,
      ).toBe(400);
      expect((await decide(await approverToken(), { decision: 'approve' })).statusCode).toBe(400);
      // deny requires a note
      expect(
        (await decide(await approverToken(), { decision: 'deny', subject_digest: SUBJECT_DIGEST }))
          .statusCode,
      ).toBe(400);
    });

    it('404 for a cross-tenant approval', async () => {
      approvalView = makeApprovalView({
        subject: { ...makeApprovalView().subject, tenant: 'globex', principal: 'user:eve' },
      });
      const res = await decide(await approverToken(), {
        decision: 'approve',
        subject_digest: SUBJECT_DIGEST,
      });
      expect(res.statusCode).toBe(404);
      expect(decideCalls).toHaveLength(0);
    });

    it('409 when the approval is already decided', async () => {
      approvalView = makeApprovalView({ status: 'granted' });
      const res = await decide(await approverToken(), {
        decision: 'approve',
        subject_digest: SUBJECT_DIGEST,
      });
      expect(res.statusCode).toBe(409);
      expect(decideCalls).toHaveLength(0);
    });

    it('403 for self-approval: the subject may not decide their own delegation', async () => {
      // The approver token's sub equals the subject principal.
      const selfToken = await makeToken({ sub: 'user:jane.doe', scope: 'approvals:decide' });
      const res = await decide(selfToken, { decision: 'approve', subject_digest: SUBJECT_DIGEST });
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).toContain('separation of duties');
      expect(decideCalls).toHaveLength(0);
    });

    it('409 for a stale subject digest', async () => {
      const res = await decide(await approverToken(), {
        decision: 'approve',
        subject_digest: `sha256:${'b'.repeat(64)}`,
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.stringify(res.json())).toContain('stale approval context');
      expect(decideCalls).toHaveLength(0);
    });

    it('400 for a non-uuid approval id (never interpolated into a workflow id)', async () => {
      const res = await decide(
        await approverToken(),
        {
          decision: 'approve',
          subject_digest: SUBJECT_DIGEST,
        },
        'not-a-uuid',
      );
      expect(res.statusCode).toBe(400);
      expect(decideCalls).toHaveLength(0);
    });
  });

  describe('deployment API', () => {
    const deployToken = () => makeToken({ sub: 'svc:ci', scope: 'deploy:write deploy:read' });

    it('starts a deployment (202) with initiated_by from the token and merged config', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await deployToken()}` },
        payload: {
          agent_id: 'knowledge-agent',
          candidate_version: '0.2.0',
          tenant: 'acme',
          config: { shadow_soak_s: 4, ramp_steps: [5, 100] },
        },
      });
      expect(res.statusCode).toBe(202);
      const req = deployStarts.at(-1)!.request;
      expect(req.initiated_by).toBe('svc:ci');
      expect(req.tenant).toBe('acme');
      expect(req.config.shadow_soak_s).toBe(4);
      expect(req.config.ramp_steps).toEqual([5, 100]);
      // Unspecified thresholds fall back to defaults.
      expect(req.config.thresholds.max_p95_ratio).toBe(1.5);
    });

    it('403s a non-platform caller deploying into a foreign tenant', async () => {
      // A tenant-user token (non-platform, non-svc) may only target its own tenant.
      const userToken = () =>
        makeToken({ sub: 'user:jane.doe', roles: ['tenant-user'], scope: 'deploy:write' });
      const foreign = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await userToken()}` },
        payload: { agent_id: 'knowledge-agent', candidate_version: '0.2.0', tenant: 'globex' },
      });
      expect(foreign.statusCode).toBe(403);
      expect(deployStarts).toHaveLength(0);

      const own = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await userToken()}` },
        payload: { agent_id: 'knowledge-agent', candidate_version: '0.2.0', tenant: 'acme' },
      });
      expect(own.statusCode).toBe(202);
    });

    it('409s a second concurrent deployment (singleton)', async () => {
      deployStartResult = { outcome: 'already_running' };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await deployToken()}` },
        payload: { agent_id: 'knowledge-agent', candidate_version: '0.2.0' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('validates agent_id and candidate_version', async () => {
      const badId = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await deployToken()}` },
        payload: { agent_id: 'Not_An_Id', candidate_version: '0.2.0' },
      });
      expect(badId.statusCode).toBe(400);
      const badVer = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await deployToken()}` },
        payload: { agent_id: 'knowledge-agent', candidate_version: 'latest' },
      });
      expect(badVer.statusCode).toBe(400);
    });

    it('requires deploy:write to start and deploy:read to query', async () => {
      const noScope = await app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${await makeToken()}` },
        payload: { agent_id: 'knowledge-agent', candidate_version: '0.2.0' },
      });
      expect(noScope.statusCode).toBe(403);

      const readNoScope = await app.inject({
        url: '/v1/deployments/knowledge-agent',
        headers: { authorization: `Bearer ${await makeToken()}` },
      });
      expect(readNoScope.statusCode).toBe(403);
    });

    it('reads status and 404s an unknown agent', async () => {
      const ok = await app.inject({
        url: '/v1/deployments/knowledge-agent',
        headers: { authorization: `Bearer ${await deployToken()}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ phase: string }>().phase).toBe('canary');

      deployStatusResponse = undefined;
      const missing = await app.inject({
        url: '/v1/deployments/knowledge-agent',
        headers: { authorization: `Bearer ${await deployToken()}` },
      });
      expect(missing.statusCode).toBe(404);
    });

    it('aborts a running deployment (202), 404 when none, 409 when terminal', async () => {
      const abort = await app.inject({
        method: 'POST',
        url: '/v1/deployments/knowledge-agent/abort',
        headers: { authorization: `Bearer ${await deployToken()}` },
      });
      expect(abort.statusCode).toBe(202);

      deployAbortResult = { outcome: 'not_found' };
      const none = await app.inject({
        method: 'POST',
        url: '/v1/deployments/knowledge-agent/abort',
        headers: { authorization: `Bearer ${await deployToken()}` },
      });
      expect(none.statusCode).toBe(404);

      deployAbortResult = { outcome: 'already_terminal' };
      const terminal = await app.inject({
        method: 'POST',
        url: '/v1/deployments/knowledge-agent/abort',
        headers: { authorization: `Bearer ${await deployToken()}` },
      });
      expect(terminal.statusCode).toBe(409);
    });
  });
});
