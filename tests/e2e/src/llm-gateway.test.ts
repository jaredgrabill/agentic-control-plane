/**
 * Phase 3 Item 0a scenario: the LLM Gateway as the one door to model
 * providers, driven directly with real platform tokens against the dev
 * stack. Covers: a deterministic dev-provider completion with usage
 * accounting; the model.invoked audit; the manifest model allowlist on a
 * delegated agent token (allow + 403); intra-call provider failover on
 * the failover-proof class; simulated prompt-cache accounting on a
 * repeated static prefix; and the fleet kill switch halting completions
 * within the propagation SLO, then clearing.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type ChildProcess } from 'node:child_process';
import type { AuditEvent } from '@acp/protocol';
import { KillSwitchControl, connectBus } from '@acp/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  LLM_GATEWAY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

let platform: ChildProcess | undefined;

async function getToken(clientId: string, clientSecret: string, audience: string, scope?: string) {
  const res = await fetch(`${TOKEN_URL}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const ciToken = (audience: string, scope: string) =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);
const llmToken = () => ciToken('acp:llm', 'llm:invoke');

interface CompletionResponse {
  text: string;
  model_class: string;
  model: string;
  provider: string;
  model_classes_version: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  attempts: { provider: string; model: string; outcome: string; duration_ms: number }[];
}

interface ErrorBody {
  error: { class: string; message: string; status: number; retry_after_s?: number };
}

async function complete(
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${LLM_GATEWAY_URL}/v1/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const promptOf = (staticText: string, variableText: string) => ({
  static: [{ role: 'system', text: staticText }],
  variable: [{ role: 'user', text: variableText }],
});

async function auditEvents(tenant: string, taskId: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=${tenant}&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

async function waitForAudit(
  tenant: string,
  taskId: string,
  ready: (events: AuditEvent[]) => boolean,
): Promise<AuditEvent[]> {
  let events: AuditEvent[] = [];
  for (let i = 0; i < 20; i++) {
    events = await auditEvents(tenant, taskId);
    if (ready(events)) return events;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return events;
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 3 llm gateway scenario', () => {
  it('completes default-tier deterministically for an acp:llm service token', async () => {
    const res = await complete(await llmToken(), {
      model_class: 'default-tier',
      prompt: promptOf('You are the e2e suite.', 'hello llm gateway'),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as CompletionResponse;
    expect(body.text).toMatch(/^dev-llm@1 sha256:[0-9a-f]{12} hello llm gateway$/);
    expect(body.model_class).toBe('default-tier');
    expect(body.provider).toBe('dev');
    expect(body.model).toBe('dev-echo@1');
    expect(body.model_classes_version).toBe('2026.07');
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({ provider: 'dev', model: 'dev-echo@1', outcome: 'ok' });

    // Determinism: the same prompt answers with the same text.
    const again = await complete(await llmToken(), {
      model_class: 'default-tier',
      prompt: promptOf('You are the e2e suite.', 'hello llm gateway'),
    });
    expect(((await again.json()) as CompletionResponse).text).toBe(body.text);
  });

  it('records a model.invoked audit event joined by task id', async () => {
    const taskId = randomUUID();
    const res = await complete(await llmToken(), {
      model_class: 'default-tier',
      prompt: promptOf('You are the e2e suite.', 'audit me'),
      metadata: { task_id: taskId, purpose: 'probe' },
    });
    expect(res.status).toBe(200);

    const events = await waitForAudit('platform', taskId, (all) =>
      all.some((e) => e.event_type === 'model.invoked'),
    );
    const invoked = events.find((e) => e.event_type === 'model.invoked');
    expect(invoked, 'no model.invoked audit event').toBeDefined();
    expect(invoked!.actor.principal).toBe('svc:agent-ci');
    expect(invoked!.action.name).toBe('llm:default-tier');
    expect(invoked!.action.inputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(invoked!.action.outputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const details = invoked!.details as {
      model_class: string;
      outcome: string;
      model_classes_version: string;
      purpose: string;
      usage: { output_tokens: number };
    };
    expect(details.model_class).toBe('default-tier');
    expect(details.outcome).toBe('ok');
    expect(details.model_classes_version).toBe('2026.07');
    expect(details.purpose).toBe('probe');
    expect(details.usage.output_tokens).toBeGreaterThan(0);
  });

  it('enforces the manifest model allowlist on delegated agent tokens', async () => {
    // The allowlist reads the registered card: make cloud-agent active.
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'agents', 'cloud', 'manifest.yaml'),
      'cloud-agent',
      writeToken,
      'llm gateway e2e allowlist scenario',
    );

    // Forge the exact delegated shape the orchestrator brokers: jane's
    // token exchanged into the cloud-agent identity.
    const subjectToken = await getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
    const exchange = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: subjectToken,
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:inventory:read',
        actor: 'agent:cloud-agent@0.1.0',
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const { access_token } = (await exchange.json()) as { access_token: string };

    // default-tier is in cloud-agent's manifest models.allowed → 200.
    const allowed = await complete(access_token, {
      model_class: 'default-tier',
      prompt: promptOf('You are the cloud agent.', 'what changed in prod?'),
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);

    // reasoning-tier is not → 403 model_not_allowed, before any provider.
    const denied = await complete(access_token, {
      model_class: 'reasoning-tier',
      prompt: promptOf('You are the cloud agent.', 'think hard about prod'),
    });
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as ErrorBody;
    expect(body.error.class).toBe('model_not_allowed');
    expect(body.error.message).toContain('cloud-agent');
    expect(body.error.message).toContain('default-tier');
  });

  it('fails over inside one call on the failover-proof class', async () => {
    const res = await complete(await llmToken(), {
      model_class: 'failover-proof',
      prompt: promptOf('You are the e2e suite.', 'prove the failover'),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as CompletionResponse;
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]).toMatchObject({ model: 'dev-fail-429@1', outcome: 'rate_limited' });
    expect(body.attempts[1]).toMatchObject({ model: 'dev-echo@1', outcome: 'ok' });
    expect(body.model).toBe('dev-echo@1');
    expect(body.text).toContain('prove the failover');
  });

  it('bills a repeated static prefix as a cache read (simulated accounting)', async () => {
    const staticText = `stable rubric ${randomUUID()} — long enough to be worth caching`;
    const first = (await (
      await complete(await llmToken(), {
        model_class: 'cheap-tier',
        prompt: promptOf(staticText, 'first question'),
      })
    ).json()) as CompletionResponse;
    expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(first.usage.cache_read_input_tokens).toBe(0);

    const second = (await (
      await complete(await llmToken(), {
        model_class: 'cheap-tier',
        prompt: promptOf(staticText, 'second question, same prefix'),
      })
    ).json()) as CompletionResponse;
    expect(second.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(second.usage.cache_creation_input_tokens).toBe(0);
  });

  it('halts completions on fleet kill switch within the SLO and recovers when cleared', async () => {
    const nc = await connectBus({
      name: 'llm-gateway-e2e',
      user: 'gateway',
      password: 'gateway-dev-password',
    });
    const control = await KillSwitchControl.open(nc);
    try {
      await control.haltFleet('llm gateway e2e drill', 'svc:agent-ci');

      // <10s propagation SLO: poll until the gateway refuses.
      const deadline = Date.now() + 10_000;
      let refused: Response | undefined;
      for (;;) {
        const res = await complete(await llmToken(), {
          model_class: 'default-tier',
          prompt: promptOf('You are the e2e suite.', 'are we halted?'),
        });
        if (res.status === 503) {
          refused = res;
          break;
        }
        expect(Date.now(), 'kill switch did not propagate within 10s').toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 250));
      }
      const body = (await refused.json()) as ErrorBody;
      expect(body.error.class).toBe('killswitch');
      expect(body.error.message).toContain('fleet halt');
    } finally {
      await control.resumeFleet();
      await nc.drain();
    }

    // Cleared: completions flow again (watcher propagation, same SLO).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await complete(await llmToken(), {
        model_class: 'default-tier',
        prompt: promptOf('You are the e2e suite.', 'recovered?'),
      });
      if (res.status === 200) break;
      expect(Date.now(), 'kill switch clear did not propagate within 10s').toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 250));
    }
  });
});
