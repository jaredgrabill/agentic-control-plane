/**
 * The enforcement pipeline + failover loop over scripted fake adapters,
 * so the tests pin the ORDER of things — kill switch before anything,
 * allowlist before any provider contact, retry counts and backoff per
 * binding, upstream_auth skipping intra-binding retries — not just the
 * outcomes.
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@acp/protocol';
import { createLogger, type PlatformClaims } from '@acp/service-kit';
import type { CompletionRequest, LlmErrorBody } from '@acp/llm-client';
import { RegistryUnavailableError, type AllowlistCheck } from '../src/allowlist.js';
import { parseModelClasses } from '../src/classes.js';
import { resolveCaller, type Caller } from '../src/caller.js';
import { LlmGatewayCore, type CoreDeps, type KillSwitch } from '../src/core.js';
import {
  DevProvider,
  ProviderFault,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderRequest,
} from '../src/providers/index.js';

const logger = createLogger('llm-gateway-core-test');

// ---------------------------------------------------------------- callers

function claimsFor(overrides: Partial<PlatformClaims>): PlatformClaims {
  return {
    sub: 'svc:agent-ci',
    aud: 'acp:llm',
    tenant: 'platform',
    roles: ['platform'],
    scope: 'llm:invoke',
    ...overrides,
  };
}

const serviceCaller = (): Caller => resolveCaller(claimsFor({}));

const agentCaller = (): Caller =>
  resolveCaller(
    claimsFor({
      sub: 'user:jane.doe',
      aud: 'acp:agent:cloud-agent',
      tenant: 'acme',
      scope: '',
      act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    }),
  );

// ---------------------------------------------------------------- fakes

type Script = () => Promise<ProviderCompletion>;

class ScriptedAdapter implements ProviderAdapter {
  calls: { model: string; request: ProviderRequest }[] = [];

  constructor(private readonly script: Script[]) {}

  complete(model: string, request: ProviderRequest): Promise<ProviderCompletion> {
    this.calls.push({ model, request });
    const step = this.script.shift();
    if (step === undefined) throw new Error('scripted adapter exhausted');
    return step();
  }
}

const succeed =
  (text = 'scripted answer'): Script =>
  () =>
    Promise.resolve({
      text,
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

const failWith =
  (fault: ProviderFault): Script =>
  () =>
    Promise.reject(fault);

const rateLimited = (retryAfterS = 1) =>
  new ProviderFault('rate_limited', 'scripted 429', retryAfterS);
const serverFault = () => new ProviderFault('server', 'scripted 500');

function configOf(classes: Record<string, { bindings: Record<string, unknown>[] }>) {
  return parseModelClasses(
    JSON.stringify({
      kind: 'acp-model-classes/v1',
      version: '2026.07',
      providers: { primary: { type: 'dev' }, secondary: { type: 'dev' } },
      classes,
    }),
    'core-test.json',
  );
}

interface Harness {
  core: LlmGatewayCore;
  audits: AuditEvent[];
  sleeps: number[];
  allowlistCalls: string[];
}

function harness(
  overrides: Partial<CoreDeps> & {
    classes?: Record<string, { bindings: Record<string, unknown>[] }>;
  },
): Harness {
  const audits: AuditEvent[] = [];
  const sleeps: number[] = [];
  const allowlistCalls: string[] = [];
  const deps: CoreDeps = {
    config:
      overrides.config ??
      configOf(
        overrides.classes ?? {
          'default-tier': { bindings: [{ provider: 'primary', model: 'dev-echo@1' }] },
        },
      ),
    providers: overrides.providers ?? new Map([['primary', new DevProvider()]]),
    allowlist: overrides.allowlist ?? {
      check: (agentId: string, modelClass: string) => {
        allowlistCalls.push(`${agentId} ${modelClass}`);
        return Promise.resolve<AllowlistCheck>({
          allowed: modelClass === 'default-tier',
          allowedClasses: ['default-tier'],
        });
      },
    },
    audit: overrides.audit ?? {
      publish: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
    },
    // Required dep (fail-closed wiring); the default stub has no active switch.
    killSwitch: overrides.killSwitch ?? {
      fleetHalt: () => undefined,
      agentSuspension: () => undefined,
    },
    logger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: overrides.random ?? (() => 1), // deterministic full-jitter upper bound
    deadlineMs: overrides.deadlineMs,
    now: overrides.now,
  };
  return { core: new LlmGatewayCore(deps), audits, sleeps, allowlistCalls };
}

const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model_class: 'default-tier',
  prompt: {
    static: [{ role: 'system', text: 'You are scripted.' }],
    variable: [{ role: 'user', text: 'question one' }],
  },
  ...overrides,
});

const errorOf = (body: unknown) => (body as LlmErrorBody).error;

// ------------------------------------------------------------------ tests

describe('happy path', () => {
  it('completes via the first binding with usage, attempts, and a model.invoked audit', async () => {
    const { core, audits } = harness({});
    const result = await core.complete(serviceCaller(), request(), {
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.model_class).toBe('default-tier');
    expect(result.body.model).toBe('dev-echo@1');
    expect(result.body.provider).toBe('primary');
    expect(result.body.model_classes_version).toBe('2026.07');
    expect(result.body.attempts).toEqual([
      expect.objectContaining({ provider: 'primary', model: 'dev-echo@1', outcome: 'ok' }),
    ]);
    expect(result.body.usage.cache_creation_input_tokens).toBeGreaterThan(0);

    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.event_type).toBe('model.invoked');
    expect(audit.actor.principal).toBe('svc:agent-ci');
    expect(audit.action.name).toBe('llm:default-tier');
    expect(audit.action.inputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(audit.action.outputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(audit.reason?.task_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');
    expect(audit.artifacts?.model).toBe('primary/dev-echo@1');
    const details = audit.details as Record<string, unknown>;
    expect(details.model_class).toBe('default-tier');
    expect(details.outcome).toBe('ok');
    expect(details.model_classes_version).toBe('2026.07');
    expect(details.prefix_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records purpose in the audit and lets body metadata win over headers', async () => {
    const { core, audits } = harness({});
    const bodyTaskId = '11111111-2222-7333-8444-555555555555';
    await core.complete(
      serviceCaller(),
      request({ metadata: { task_id: bodyTaskId, purpose: 'judge' } }),
      { taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    );
    expect(audits[0]!.reason?.task_id).toBe(bodyTaskId);
    expect((audits[0]!.details as Record<string, unknown>).purpose).toBe('judge');
  });

  it('lists model classes as provider/model pairs', () => {
    const { core } = harness({
      classes: {
        'default-tier': { bindings: [{ provider: 'primary', model: 'dev-echo@1' }] },
        'failover-proof': {
          bindings: [
            { provider: 'primary', model: 'dev-fail-429@1' },
            { provider: 'secondary', model: 'dev-echo@1' },
          ],
        },
      },
    });
    expect(core.modelClasses()).toEqual({
      version: '2026.07',
      classes: {
        'default-tier': { models: ['primary/dev-echo@1'] },
        'failover-proof': {
          models: ['primary/dev-fail-429@1', 'secondary/dev-echo@1'],
        },
      },
    });
  });
});

describe('kill switch and unknown classes (pre-decision refusals, no audit)', () => {
  it('fleet halt refuses everything with killswitch 503', async () => {
    const killSwitch: KillSwitch = {
      fleetHalt: () => ({ active: true, reason: 'drill' }),
      agentSuspension: () => undefined,
    };
    const { core, audits } = harness({ killSwitch });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(503);
    expect(errorOf(result.body).class).toBe('killswitch');
    expect(audits).toHaveLength(0);
  });

  it('agent suspension refuses agent callers only', async () => {
    const killSwitch: KillSwitch = {
      fleetHalt: () => undefined,
      agentSuspension: (id) => (id === 'cloud-agent' ? { active: true } : undefined),
    };
    const { core } = harness({ killSwitch });
    const suspended = await core.complete(agentCaller(), request(), {});
    expect(suspended.status).toBe(503);
    expect(errorOf(suspended.body).class).toBe('killswitch');
    expect(errorOf(suspended.body).message).toContain('cloud-agent is suspended');

    const service = await core.complete(serviceCaller(), request(), {});
    expect(service.status).toBe(200);
  });

  it('an unknown model class is a 400 naming the registry version, NOT the catalog', async () => {
    const { core, audits } = harness({});
    const result = await core.complete(
      serviceCaller(),
      request({ model_class: 'quantum-tier' }),
      {},
    );
    expect(result.status).toBe(400);
    expect(errorOf(result.body).class).toBe('model_class_unknown');
    expect(errorOf(result.body).message).toContain('quantum-tier');
    expect(errorOf(result.body).message).toContain('2026.07');
    // The configured class names must NOT be enumerated to an arbitrary
    // authenticated caller — modelClasses() is the discovery surface.
    expect(errorOf(result.body).message).not.toContain('default-tier');
    expect(audits).toHaveLength(0);
  });
});

describe('model allowlist', () => {
  it('allows an agent caller inside its manifest classes and never consults it for services', async () => {
    const { core, allowlistCalls } = harness({});
    const viaAgent = await core.complete(agentCaller(), request(), {});
    expect(viaAgent.status).toBe(200);
    expect(allowlistCalls).toEqual(['cloud-agent default-tier']);

    await core.complete(serviceCaller(), request(), {});
    expect(allowlistCalls).toHaveLength(1);
  });

  it('refuses a class outside models.allowed with 403 and audits the refusal', async () => {
    const { core, audits } = harness({
      classes: {
        'default-tier': { bindings: [{ provider: 'primary', model: 'dev-echo@1' }] },
        'reasoning-tier': { bindings: [{ provider: 'primary', model: 'dev-echo@1' }] },
      },
    });
    const result = await core.complete(
      agentCaller(),
      request({ model_class: 'reasoning-tier' }),
      {},
    );
    expect(result.status).toBe(403);
    expect(errorOf(result.body).class).toBe('model_not_allowed');
    expect(errorOf(result.body).message).toContain('cloud-agent');
    expect(errorOf(result.body).message).toContain('[default-tier]');
    expect(audits).toHaveLength(1);
    expect((audits[0]!.details as Record<string, unknown>).outcome).toBe('model_not_allowed');
    expect(audits[0]!.artifacts?.agent_id).toBe('cloud-agent');
    expect(audits[0]!.action.outputs_digest).toBeUndefined();
  });

  it('fails CLOSED as 503 when the registry cannot answer', async () => {
    const { core, audits } = harness({
      allowlist: {
        check: () => Promise.reject(new RegistryUnavailableError('registry answered 500')),
      },
    });
    const result = await core.complete(agentCaller(), request(), {});
    expect(result.status).toBe(503);
    expect(errorOf(result.body).class).toBe('unavailable');
    expect(errorOf(result.body).message).toContain('model allowlist unavailable');
    expect((audits[0]!.details as Record<string, unknown>).outcome).toBe('unavailable');
  });
});

describe('prompt validation', () => {
  it('refuses an oversized static section as invalid_input and audits it', async () => {
    const { core, audits } = harness({});
    const block = { role: 'system' as const, text: 's' };
    const result = await core.complete(
      serviceCaller(),
      request({ prompt: { static: [block, block, block, block, block], variable: [block] } }),
      {},
    );
    expect(result.status).toBe(400);
    expect(errorOf(result.body).class).toBe('invalid_input');
    expect((audits[0]!.details as Record<string, unknown>).outcome).toBe('invalid_input');
  });
});

describe('failover loop', () => {
  const twoBindings = {
    'default-tier': {
      bindings: [
        { provider: 'primary', model: 'model-a' },
        { provider: 'secondary', model: 'model-b' },
      ],
    },
  };

  it('retries a binding up to max_attempts with full-jitter backoff, then fails over in order', async () => {
    const primary = new ScriptedAdapter([failWith(serverFault()), failWith(serverFault())]);
    const secondary = new ScriptedAdapter([succeed('from secondary')]);
    const { core, sleeps } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.text).toBe('from secondary');
    expect(result.body.provider).toBe('secondary');
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(1);
    expect(result.body.attempts.map((a) => a.outcome)).toEqual(['server', 'server', 'ok']);
    // One backoff between the two primary attempts (random()=1 pins the
    // full-jitter upper bound: min(2000, 200·2^0) = 200), none across the
    // binding boundary.
    expect(sleeps).toEqual([200]);
  });

  it('caps exponential backoff at 2s', async () => {
    const primary = new ScriptedAdapter([
      failWith(serverFault()),
      failWith(serverFault()),
      failWith(serverFault()),
      failWith(serverFault()),
      failWith(serverFault()),
      succeed(),
    ]);
    const { core, sleeps } = harness({
      classes: {
        'default-tier': {
          bindings: [{ provider: 'primary', model: 'model-a', max_attempts: 6 }],
        },
      },
      providers: new Map<string, ProviderAdapter>([['primary', primary]]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(200);
    expect(sleeps).toEqual([200, 400, 800, 1600, 2000]);
  });

  it('fails over immediately on upstream_auth without burning the binding retries', async () => {
    const primary = new ScriptedAdapter([failWith(new ProviderFault('upstream_auth', 'bad key'))]);
    const secondary = new ScriptedAdapter([succeed('rescued')]);
    const { core, sleeps } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(200);
    expect(primary.calls).toHaveLength(1); // no intra-binding retry
    expect(sleeps).toEqual([]);
  });

  it('refuses provider invalid_input with 400 and NO failover', async () => {
    const primary = new ScriptedAdapter([
      failWith(new ProviderFault('invalid_input', 'model refused the shape')),
    ]);
    const secondary = new ScriptedAdapter([succeed()]);
    const { core, audits } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(400);
    expect(errorOf(result.body).class).toBe('invalid_input');
    expect(secondary.calls).toHaveLength(0);
    expect((audits[0]!.details as Record<string, unknown>).outcome).toBe('invalid_input');
  });

  it('answers 429 with the max retry_after when EVERY binding is terminally rate limited', async () => {
    const primary = new ScriptedAdapter([failWith(rateLimited(2)), failWith(rateLimited(2))]);
    const secondary = new ScriptedAdapter([failWith(rateLimited(5)), failWith(rateLimited(5))]);
    const { core, audits } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(429);
    expect(errorOf(result.body).class).toBe('rate_limited');
    expect(errorOf(result.body).retry_after_s).toBe(5);
    const details = audits[0]!.details as { outcome: string; attempts: unknown[] };
    expect(details.outcome).toBe('rate_limited');
    expect(details.attempts).toHaveLength(4);
  });

  it('answers 503 when the terminal faults are mixed', async () => {
    const primary = new ScriptedAdapter([failWith(rateLimited()), failWith(rateLimited())]);
    const secondary = new ScriptedAdapter([failWith(serverFault()), failWith(serverFault())]);
    const { core, audits } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(503);
    expect(errorOf(result.body).class).toBe('unavailable');
    expect(errorOf(result.body).message).toContain('all provider bindings failed after 4');
    expect((audits[0]!.details as Record<string, unknown>).outcome).toBe('unavailable');
  });

  it('stops at the overall deadline instead of grinding through remaining attempts', async () => {
    let clock = 0;
    const slowFault: Script = () => {
      clock += 40_000; // each attempt burns 40s of virtual time
      return Promise.reject(serverFault());
    };
    const primary = new ScriptedAdapter([slowFault, slowFault]);
    const secondary = new ScriptedAdapter([succeed()]);
    const { core } = harness({
      classes: twoBindings,
      providers: new Map<string, ProviderAdapter>([
        ['primary', primary],
        ['secondary', secondary],
      ]),
      now: () => new Date(clock),
      deadlineMs: 60_000,
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(503);
    expect(errorOf(result.body).message).toContain('overall deadline exceeded');
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(0); // deadline hit before binding 2
  });

  it('enforces the per-attempt timeout against an adapter that never answers', async () => {
    const hanging: ProviderAdapter = {
      complete: () => new Promise<never>(() => undefined),
    };
    const { core } = harness({
      classes: {
        'default-tier': {
          bindings: [{ provider: 'primary', model: 'model-a', max_attempts: 1, timeout_ms: 20 }],
        },
      },
      providers: new Map<string, ProviderAdapter>([['primary', hanging]]),
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(503);
    if (result.status === 503) {
      expect(errorOf(result.body).class).toBe('unavailable');
    }
  });
});

describe('prefix stability signal', () => {
  it('marks the second identical prefix stable per (caller, class), per caller', async () => {
    const { core, audits } = harness({});
    await core.complete(serviceCaller(), request(), {});
    await core.complete(serviceCaller(), request(), {});
    await core.complete(agentCaller(), request(), {});
    // The signal is span-side; assert through the audit trail's usage sim:
    // the dev provider read the cache on the 2nd and 3rd sighting of the
    // digest, while stability is per-caller (asserted via spans in E2E).
    const usages = audits.map(
      (a) => (a.details as { usage: { cache_read_input_tokens: number } }).usage,
    );
    expect(usages[0]!.cache_read_input_tokens).toBe(0);
    expect(usages[1]!.cache_read_input_tokens).toBeGreaterThan(0);
    expect(usages[2]!.cache_read_input_tokens).toBeGreaterThan(0);
  });
});

describe('audit resilience', () => {
  it('alarm-and-continue: a failing audit sink never fails the completion (R0)', async () => {
    const { core } = harness({
      audit: { publish: () => Promise.reject(new Error('nats down')) },
    });
    const result = await core.complete(serviceCaller(), request(), {});
    expect(result.status).toBe(200);
  });
});
