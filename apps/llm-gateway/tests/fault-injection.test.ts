/**
 * SDK-level fault injection: a REAL Agent executing through a REAL
 * GatewayModel against an in-process llm-gateway (fastify inject as the
 * fetch), driving the dev provider's scripted-failure models — the full
 * two-layer retry story observed from the agent's side:
 *
 *   [dev-fail-429 → dev-echo]      gateway failover absorbs the fault
 *   [dev-fail-429 → dev-fail-500]  gateway gives up → GatewayModel maps
 *                                  the 503 → CapabilityError(Retryable) →
 *                                  agent.execute raises Temporal Retryable
 *   fleet halt mid-suite           killswitch 503 → typed retryable error
 */

import { ApplicationFailure } from '@temporalio/common';
import type { AgentManifest, AuditEvent } from '@acp/protocol';
import { Agent, GatewayModel } from '@acp/agent-sdk';
import { JwtVerifier, createLogger, type PlatformClaims } from '@acp/service-kit';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildLlmGatewayApp } from '../src/app.js';
import { parseModelClasses } from '../src/classes.js';
import { LlmGatewayCore, type KillSwitch } from '../src/core.js';
import { DevProvider, type ProviderAdapter } from '../src/providers/index.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('llm-gateway-fault-test');

const MANIFEST: AgentManifest = {
  id: 'fault-agent',
  name: 'Fault Injection Agent',
  owner: 'team-tests',
  description: 'Exercises the gateway failover from the SDK side.',
  capabilities: [
    {
      name: 'fault.ask',
      description: 'Asks the model and returns its text.',
      risk: 'R0',
      input_schema: { type: 'object' },
      output_schema: {
        type: 'object',
        required: ['text', 'citations', 'confidence'],
        properties: {
          text: { type: 'string' },
          citations: { type: 'array' },
          confidence: { type: 'number' },
        },
      },
      examples: [{ input: {} }, { input: {} }, { input: {} }],
    },
  ],
};

const config = parseModelClasses(
  JSON.stringify({
    kind: 'acp-model-classes/v1',
    version: '2026.07',
    providers: { dev: { type: 'dev' } },
    classes: {
      'failover-tier': {
        bindings: [
          { provider: 'dev', model: 'dev-fail-429@1', max_attempts: 1 },
          { provider: 'dev', model: 'dev-echo@1', max_attempts: 1 },
        ],
      },
      'doomed-tier': {
        bindings: [
          { provider: 'dev', model: 'dev-fail-429@1', max_attempts: 1 },
          { provider: 'dev', model: 'dev-fail-500@1', max_attempts: 1 },
        ],
      },
    },
  }),
  'fault-test.json',
);

const auditEvents: AuditEvent[] = [];
let fleetHalted = false;
let app: FastifyInstance;
let delegatedToken: string;

/** fastify inject as the GatewayModel's fetch — no sockets anywhere. */
const injectFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const options: InjectOptions = {
    method: init?.method === 'POST' ? 'POST' : 'GET',
    url: url.pathname,
    headers: init?.headers as Record<string, string>,
    ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
  };
  const res = await app.inject(options);
  return new Response(res.payload, { status: res.statusCode });
};

function agentWith(modelClass: string): Agent {
  const agent = new Agent({
    manifest: MANIFEST,
    model: new GatewayModel({
      url: 'http://in-process',
      modelClass,
      staticPrefix: [{ role: 'system', text: 'You are the fault agent.' }],
      fetchImpl: injectFetch,
    }),
  });
  agent.capability('fault.ask', async (ctx, input) => {
    const question = typeof input.question === 'string' ? input.question : 'anything';
    const completion = await ctx.model.complete(question);
    return { text: completion.text, citations: [], confidence: 0.9 };
  });
  return agent;
}

const step = (question: string) => ({
  kind: 'step_request',
  step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
  task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
  tenant: 'acme',
  agent_id: 'fault-agent',
  capability: 'fault.ask',
  input: { question },
  delegated_token: delegatedToken,
});

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(pair.publicKey);

  const claims: Partial<PlatformClaims> = {
    sub: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: '',
    act: { sub: 'agent:fault-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
  };
  delegatedToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience('acp:agent:fault-agent')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);

  const killSwitch: KillSwitch = {
    fleetHalt: () => (fleetHalted ? { active: true, reason: 'drill' } : undefined),
    agentSuspension: () => undefined,
  };
  const core = new LlmGatewayCore({
    config,
    providers: new Map<string, ProviderAdapter>([['dev', new DevProvider()]]),
    allowlist: {
      check: (_agentId, modelClass) =>
        Promise.resolve({
          allowed: ['failover-tier', 'doomed-tier'].includes(modelClass),
          allowedClasses: ['failover-tier', 'doomed-tier'],
        }),
    },
    audit: {
      publish: (event) => {
        auditEvents.push(event);
        return Promise.resolve();
      },
    },
    killSwitch,
    logger,
    sleep: () => Promise.resolve(),
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
  fleetHalted = false;
});

describe('fault injection through the SDK', () => {
  it('[dev-fail-429 → dev-echo]: the gateway absorbs the fault; the step completes on attempt 2', async () => {
    const result = await agentWith('failover-tier').execute(step('does failover work?'));
    expect(result.status).toBe('completed');
    expect((result.output as { text: string }).text).toContain('does failover work?');
    // The completion's audit trail shows both attempts.
    const details = auditEvents.at(-1)!.details as {
      outcome: string;
      attempts: { model: string; outcome: string }[];
    };
    expect(details.outcome).toBe('ok');
    expect(details.attempts.map((a) => a.outcome)).toEqual(['rate_limited', 'ok']);
    expect(details.attempts[0]!.model).toBe('dev-fail-429@1');
  });

  it('[dev-fail-429 → dev-fail-500]: exhaustion → 503 → CapabilityError(Retryable) → Temporal Retryable', async () => {
    const outcome = await agentWith('doomed-tier')
      .execute(step('is anyone there?'))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(outcome).toBeInstanceOf(ApplicationFailure);
    const failure = outcome as ApplicationFailure;
    expect(failure.type).toBe('Retryable');
    expect(failure.nonRetryable).toBe(false);
    expect(failure.message).toContain('all provider bindings failed');
    // The gateway audited the failed completion with the full attempt trail.
    const details = auditEvents.at(-1)!.details as { outcome: string; attempts: unknown[] };
    expect(details.outcome).toBe('unavailable');
    expect(details.attempts).toHaveLength(2);
  });

  it('kill switch mid-suite: fleet halt turns completions into typed retryable failures', async () => {
    fleetHalted = true;
    const outcome = await agentWith('failover-tier')
      .execute(step('halted?'))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(outcome).toBeInstanceOf(ApplicationFailure);
    expect((outcome as ApplicationFailure).type).toBe('Retryable');
    expect((outcome as ApplicationFailure).message).toContain('fleet halt is active');

    fleetHalted = false;
    const recovered = await agentWith('failover-tier').execute(step('recovered?'));
    expect(recovered.status).toBe('completed');
  });
});
