/**
 * Phase 4 item 2 scenario: the netsec agent (R0/R1, zero write surface)
 * answers an exposure question through the real stack — gateway →
 * orchestrator → Temporal worker → ToolClient → Tool Gateway PEP → mock
 * netsec MCP server — with delegation, per-tool Cedar allows, and the audit
 * trail. Deterministic handlers, zero LLM calls; capability semantics are
 * unit/eval-covered, not driven here.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

let platform: ChildProcess;

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
const janeToken = () => getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');

async function submitTask(
  text: string,
  capability: string,
  context: Record<string, unknown>,
): Promise<{ task_id: string; status: number }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text, capability, context }),
  });
  const body = (await res.json()) as { task_id: string };
  return { task_id: body.task_id, status: res.status };
}

async function waitForResult(taskId: string, timeoutMs = 90_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (body.status === 'completed' || body.status === 'failed') {
      expect(body.result, `task ${taskId} ${body.status} with no result`).not.toBeNull();
      return body.result!;
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} still ${body.status} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function auditEvents(taskId: string, tenant = 'acme'): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=${tenant}&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 4 netsec agent scenario', () => {
  it('registers and activates the netsec agent at the worker version', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    // 0.1.0 matches ACP_AGENT_VERSION in run-platform.mjs and eval-report.ts.
    await registerAndActivate(
      join(repoRoot, 'agents', 'netsec', 'manifest.yaml'),
      'netsec-agent',
      writeToken,
      'phase 4 netsec agent promotion',
    );
  });

  let exposureTaskId: string;

  it('answers the payments exposure question with both netsec citations', async () => {
    const submitted = await submitTask(
      'Is payments-api exposed to the internet?',
      'netsec.exposure_analysis',
      { service: 'payments-api' },
    );
    expect(submitted.status).toBe(202);
    exposureTaskId = submitted.task_id;

    const result = await waitForResult(exposureTaskId);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('internet');
    expect(text).toContain('0.0.0.0/0');
    expect(text).toContain('sg-payments-01');
    expect(result.answer!.confidence).toBeGreaterThan(0.35);

    const citations = result.answer!.citations;
    const secGroups = citations.find((c) => c.doc_id === 'netsec/security-groups');
    expect(secGroups, 'answer must cite the security-group snapshot').toBeDefined();
    expect(secGroups!.version).toBe('2026-07-10');
    const ipam = citations.find((c) => c.doc_id === 'netsec/ipam-allocations');
    expect(ipam, 'answer must cite the IPAM snapshot').toBeDefined();
    for (const citation of citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('recorded the delegation, allow decision, and zero-LLM usage in the audit trail', async () => {
    // The audit consumer is asynchronous; give the stream a moment.
    let events: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events = await auditEvents(exposureTaskId);
      if (events.length >= 4 && events.some((e) => e.event_type === 'step.completed')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const types = events.map((e) => e.event_type);
    for (const expected of [
      'task.submitted',
      'step.dispatched',
      'policy.decision',
      'step.completed',
    ]) {
      expect(types, `missing ${expected} in [${types.join(', ')}]`).toContain(expected);
    }
    // The netsec agent does no retrieval — the knowledge path must not appear.
    expect(types).not.toContain('retrieval.served');

    const dispatched = events.find((e) => e.event_type === 'step.dispatched')!;
    expect(dispatched.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
    ]);
    expect(dispatched.artifacts?.agent_id).toBe('netsec-agent');

    const decision = events.find((e) => e.event_type === 'policy.decision')!;
    expect(decision.reason?.policy?.decision).toBe('allow');

    const completed = events.find((e) => e.event_type === 'step.completed')!;
    const usage = (completed.details as { usage?: { llm_calls?: number } }).usage;
    expect(usage, 'step.completed must carry usage').toBeDefined();
    expect(usage!.llm_calls, 'the netsec agent is zero-LLM in v0').toBe(0);
  });

  it('recorded both R0 read tool calls through the gateway PEP with per-tool allows', async () => {
    let toolEvents: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      toolEvents = (await auditEvents(exposureTaskId)).filter(
        (e) => e.event_type === 'tool.called',
      );
      if (toolEvents.length >= 2) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(toolEvents.map((e) => e.action.name).sort()).toEqual([
      'tool:netsec:ipam_lookup',
      'tool:netsec:security_group_get',
    ]);

    for (const event of toolEvents) {
      const chain = event.actor.delegation_chain!.map((l) => l.sub);
      expect(chain).toHaveLength(3);
      expect(chain[0]).toBe('user:jane.doe');
      expect(chain[1]).toBe('svc:orchestrator');
      expect(chain[2]).toMatch(/^agent:netsec-agent@/);
      expect(event.actor.principal).toMatch(/^agent:netsec-agent@/);
      expect(event.reason?.policy?.decision).toBe('allow');
      expect(event.action.inputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const details = event.details as { server?: string; outcome?: string };
      expect(details.server).toBe('netsec');
      expect(details.outcome).toBe('ok');
      expect(event.artifacts?.lineage_ids?.length).toBeGreaterThan(0);
    }

    const sgEvent = toolEvents.find((e) => e.action.name === 'tool:netsec:security_group_get')!;
    expect(sgEvent.reason?.policy?.determining_policies).toContain(
      'allow-tool-netsec-security-group-get',
    );
    const ipamEvent = toolEvents.find((e) => e.action.name === 'tool:netsec:ipam_lookup')!;
    expect(ipamEvent.reason?.policy?.determining_policies).toContain(
      'allow-tool-netsec-ipam-lookup',
    );
  });
});
