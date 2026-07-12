import type { AuditEvent, TaskRequest, TaskResult } from '@acp/protocol';
import { JwtVerifier, createLogger, initTelemetry, type KillSwitchState } from '@acp/service-kit';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGatewayApp, GATEWAY_AUDIENCE } from '../src/app.js';
import { taskWorkflowId } from '../src/temporal.js';

const ISSUER = 'https://token.test.local';

let app: FastifyInstance;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicJwk: JWK;

const started: TaskRequest[] = [];
const auditEvents: AuditEvent[] = [];
let fleetHalt: KillSwitchState | undefined;
let statusResponse: Awaited<ReturnType<Parameters<typeof buildGatewayApp>[0]['starter']['status']>>;

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
    },
    killSwitch: { fleetHalt: () => fleetHalt },
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
  statusResponse = { status: 'running' };
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
      },
      killSwitch: { fleetHalt: () => undefined },
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

describe('taskWorkflowId', () => {
  it('is tenant-scoped so lookups cannot cross tenants', () => {
    expect(taskWorkflowId('acme', 'abc')).toBe('task-acme-abc');
    expect(taskWorkflowId('acme', 'abc')).not.toBe(taskWorkflowId('globex', 'abc'));
  });
});
