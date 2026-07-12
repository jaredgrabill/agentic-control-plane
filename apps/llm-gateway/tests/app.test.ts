/**
 * The HTTP door via fastify inject: real JWTs against a real JwtVerifier,
 * the real core over the dev provider, stubbed allowlist/audit — the full
 * request path minus the network.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { CompletionResponse, LlmErrorBody } from '@acp/llm-client';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildLlmGatewayApp } from '../src/app.js';
import { parseModelClasses } from '../src/classes.js';
import { LlmGatewayCore } from '../src/core.js';
import { DevProvider, type ProviderAdapter } from '../src/providers/index.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('llm-gateway-app-test');

const config = parseModelClasses(
  JSON.stringify({
    kind: 'acp-model-classes/v1',
    version: '2026.07',
    providers: { dev: { type: 'dev' } },
    classes: {
      'default-tier': { bindings: [{ provider: 'dev', model: 'dev-echo@1' }] },
      'reasoning-tier': { bindings: [{ provider: 'dev', model: 'dev-echo@1' }] },
    },
  }),
  'app-test.json',
);

const auditEvents: AuditEvent[] = [];
let app: FastifyInstance;
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  key = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);

  const core = new LlmGatewayCore({
    config,
    providers: new Map<string, ProviderAdapter>([['dev', new DevProvider()]]),
    allowlist: {
      check: (agentId, modelClass) =>
        Promise.resolve({
          allowed: modelClass === 'default-tier',
          allowedClasses: ['default-tier'],
        }),
    },
    audit: {
      publish: (event) => {
        auditEvents.push(event);
        return Promise.resolve();
      },
    },
    logger,
  });
  app = buildLlmGatewayApp({
    core,
    verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
    logger,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  auditEvents.length = 0;
});

async function makeToken(overrides: Record<string, unknown> = {}, audience = 'acp:llm') {
  return new SignJWT({
    sub: 'svc:agent-ci',
    tenant: 'platform',
    roles: ['platform'],
    scope: 'llm:invoke',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const completeBody = (modelClass = 'default-tier') => ({
  model_class: modelClass,
  prompt: {
    static: [{ role: 'system', text: 'You are scripted.' }],
    variable: [{ role: 'user', text: 'hello door' }],
  },
});

function inject(options: {
  token?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return app.inject({
    method: 'POST',
    url: '/v1/complete',
    headers: {
      'content-type': 'application/json',
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    payload: JSON.stringify(options.body ?? completeBody()),
  });
}

const errorOf = (payload: string) => (JSON.parse(payload) as LlmErrorBody).error;

describe('401 matrix', () => {
  it('no token → 401 unauthenticated', async () => {
    const res = await inject({ token: undefined });
    expect(res.statusCode).toBe(401);
    const error = errorOf(res.payload);
    expect(error.class).toBe('unauthenticated');
    expect(error.message).toBe('missing Bearer token');
  });

  it('wrong audience (acp:tools) → 401', async () => {
    const res = await inject({ token: await makeToken({}, 'acp:tools') });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).class).toBe('unauthenticated');
  });

  it('acp:llm token without llm:invoke → 401', async () => {
    const res = await inject({ token: await makeToken({ scope: 'registry:read' }) });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).message).toContain('lacks the llm:invoke scope');
  });

  it('agent audience with a mismatched actor → 401', async () => {
    const token = await makeToken(
      { act: { sub: 'agent:code-agent@0.1.0' }, scope: '' },
      'acp:agent:cloud-agent',
    );
    const res = await inject({ token });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.payload).message).toContain('does not match its actor');
  });

  it('garbage token → 401', async () => {
    const res = await inject({ token: 'eyJhbGciOiJub25lIn0.e30.' });
    expect(res.statusCode).toBe(401);
  });
});

describe('request validation', () => {
  it('schema violations → 400 invalid_input naming the path', async () => {
    const res = await inject({
      token: await makeToken(),
      body: { model_class: 'default-tier', prompt: { static: [], variable: [] } },
    });
    expect(res.statusCode).toBe(400);
    const error = errorOf(res.payload);
    expect(error.class).toBe('invalid_input');
    expect(error.message).toContain('/prompt/variable');
  });

  it('a non-JSON body → 400 invalid_input (fastify parse error, retyped)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await makeToken()}`,
      },
      payload: 'not json {',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.payload).class).toBe('invalid_input');
  });
});

describe('completions through the door', () => {
  it('service token completes deterministically with usage + attempts', async () => {
    const taskId = randomUUID();
    const res = await inject({
      token: await makeToken(),
      headers: { 'x-acp-task-id': taskId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as CompletionResponse;
    expect(body.text).toMatch(/^dev-llm@1 sha256:[0-9a-f]{12} hello door/);
    expect(body.model).toBe('dev-echo@1');
    expect(body.provider).toBe('dev');
    expect(body.attempts).toHaveLength(1);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.reason?.task_id).toBe(taskId);
  });

  it('delegated agent token: allowed class 200, disallowed class 403 model_not_allowed', async () => {
    const agentToken = await makeToken(
      {
        sub: 'user:jane.doe',
        tenant: 'acme',
        scope: '',
        act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
      },
      'acp:agent:cloud-agent',
    );
    const allowed = await inject({ token: agentToken });
    expect(allowed.statusCode).toBe(200);

    const denied = await inject({ token: agentToken, body: completeBody('reasoning-tier') });
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied.payload).class).toBe('model_not_allowed');
  });

  it('drops non-UUID correlation headers instead of recording junk', async () => {
    const res = await inject({
      token: await makeToken(),
      headers: { 'x-acp-task-id': 'not-a-uuid; DROP TABLE audit' },
    });
    expect(res.statusCode).toBe(200);
    expect(auditEvents[0]!.reason?.task_id).toBeUndefined();
  });
});

describe('GET /v1/model-classes', () => {
  it('answers the class map under the same auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/model-classes',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      version: '2026.07',
      classes: {
        'default-tier': { models: ['dev/dev-echo@1'] },
        'reasoning-tier': { models: ['dev/dev-echo@1'] },
      },
    });
  });

  it('refuses anonymous listing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/model-classes' });
    expect(res.statusCode).toBe(401);
  });
});

describe('HTTP surface hygiene', () => {
  it('healthz answers for the platform readiness gate', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
