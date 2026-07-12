/**
 * Phase 2 Item 3 scenario: the TS tool agents (cloud-agent, code-agent)
 * answer through the real stack — gateway → orchestrator → Temporal worker →
 * ToolClient → mock MCP server — with delegation, audit, and one trace.
 * Deterministic handlers, zero LLM calls; scripted failure modes are
 * unit-covered, not driven here.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  JAEGER_URL,
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

describe('phase 2 tool agents scenario', () => {
  it('registers and activates the cloud and code agents', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'agents', 'cloud', 'manifest.yaml'),
      'cloud-agent',
      writeToken,
      'phase 2 tool agent promotion',
    );
    await registerAndActivate(
      join(repoRoot, 'agents', 'code', 'manifest.yaml'),
      'code-agent',
      writeToken,
      'phase 2 tool agent promotion',
    );
  });

  let costTaskId: string;

  it('explains the cost spike with citations from both cloud documents', async () => {
    const submitted = await submitTask(
      'Why did cloud spend jump last week?',
      'cloud.cost_analysis',
      {},
    );
    expect(submitted.status).toBe(202);
    costTaskId = submitted.task_id;

    const result = await waitForResult(costTaskId);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('payments-api');
    expect(text).toContain('30.0');
    expect(text).toContain('d-2026-07-01-042');
    expect(result.answer!.confidence).toBeGreaterThan(0.35);

    const citations = result.answer!.citations;
    const costReport = citations.find((c) => c.doc_id === 'cloud/cost-report');
    expect(costReport, 'answer must cite the cost report').toBeDefined();
    expect(costReport!.version).toBe('2026-07-08');
    const inventory = citations.find((c) => c.doc_id === 'cloud/inventory-snapshot');
    expect(inventory, 'answer must cite the inventory snapshot').toBeDefined();
    for (const citation of citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('summarizes CI health with the deploy linkage', async () => {
    const submitted = await submitTask('How healthy is payments CI?', 'code.ci_health', {
      repo: 'acme/payments-service',
    });
    expect(submitted.status).toBe(202);

    const result = await waitForResult(submitted.task_id);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('d-2026-07-01-042');
    expect(text).toContain('pass rate');
    expect(result.answer!.citations.some((c) => c.doc_id === 'code/ci-activity')).toBe(true);
  });

  it('fails typed and un-retried when required input is missing', async () => {
    const submitted = await submitTask('List everything we run', 'cloud.inventory_query', {});
    expect(submitted.status).toBe(202);

    const result = await waitForResult(submitted.task_id);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('needs_input');
    expect(result.error?.message).toContain('provide at least one filter');
  });

  it('recorded the delegation and the zero-LLM usage in the audit trail', async () => {
    // The audit consumer is asynchronous; give the stream a moment. Wait for
    // task.completed too — the Cost Meter assertion below reads its details.
    let events: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events = await auditEvents(costTaskId);
      if (events.length >= 4 && events.some((e) => e.event_type === 'task.completed')) break;
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
    // Tool agents do no retrieval — the knowledge path must not appear.
    expect(types).not.toContain('retrieval.served');

    const dispatched = events.find((e) => e.event_type === 'step.dispatched')!;
    expect(dispatched.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
    ]);
    expect(dispatched.artifacts?.agent_id).toBe('cloud-agent');

    const decision = events.find((e) => e.event_type === 'policy.decision')!;
    expect(decision.reason?.policy?.decision).toBe('allow');

    const completed = events.find((e) => e.event_type === 'step.completed')!;
    const usage = (completed.details as { usage?: { llm_calls?: number } }).usage;
    expect(usage, 'step.completed must carry usage').toBeDefined();
    expect(usage!.llm_calls, 'tool agents are zero-LLM in v0').toBe(0);

    // Cost Meter v0: a zero-LLM task costs exactly $0 — no tokens, no charge,
    // regardless of the price book's rates.
    const taskCompleted = events.find((e) => e.event_type === 'task.completed')!;
    const cost = (taskCompleted.details as { usage_totals?: { cost_usd?: number | null } })
      .usage_totals?.cost_usd;
    expect(cost, 'zero-LLM task cost is exactly 0').toBe(0);
  });

  it('recorded both gateway tool calls with the full chain, allow decisions, and lineage', async () => {
    // Item 5: the cost-spike path now traverses the Tool Gateway — one
    // tool.called event per upstream call (cost_report, then the follow-up
    // inventory_search), joined to the task by the forwarded x-acp-task-id.
    let toolEvents: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      toolEvents = (await auditEvents(costTaskId)).filter((e) => e.event_type === 'tool.called');
      if (toolEvents.length >= 2) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(toolEvents.map((e) => e.action.name).sort()).toEqual([
      'tool:cloud-estate:cost_report',
      'tool:cloud-estate:inventory_search',
    ]);

    for (const event of toolEvents) {
      const chain = event.actor.delegation_chain!.map((l) => l.sub);
      expect(chain).toHaveLength(3);
      expect(chain[0]).toBe('user:jane.doe');
      expect(chain[1]).toBe('svc:orchestrator');
      expect(chain[2]).toMatch(/^agent:cloud-agent@/);
      expect(event.actor.principal).toMatch(/^agent:cloud-agent@/);
      expect(event.reason?.policy?.decision).toBe('allow');
      expect(event.action.inputs_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const details = event.details as { server?: string; outcome?: string };
      expect(details.server).toBe('cloud-estate');
      expect(details.outcome).toBe('ok');
      expect(event.artifacts?.lineage_ids?.length).toBeGreaterThan(0);
    }

    const costEvent = toolEvents.find((e) => e.action.name === 'tool:cloud-estate:cost_report')!;
    expect(costEvent.reason?.policy?.determining_policies).toContain(
      'allow-tool-cloud-estate-cost',
    );
    const inventoryEvent = toolEvents.find(
      (e) => e.action.name === 'tool:cloud-estate:inventory_search',
    )!;
    expect(inventoryEvent.reason?.policy?.determining_policies).toContain(
      'allow-tool-cloud-estate-inventory',
    );
  });

  it('produced one trace across gateway → orchestrator → cloud-agent', async () => {
    let services = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${JAEGER_URL}/api/traces?service=gateway&limit=40&lookback=1h`);
      const body = (await res.json()) as {
        data: { processes: Record<string, { serviceName: string }> }[] | null;
      };
      for (const traceData of body.data ?? []) {
        const names = new Set(Object.values(traceData.processes).map((p) => p.serviceName));
        if (names.size > services.size) services = names;
        if (names.has('gateway') && names.has('orchestrator') && names.has('cloud-agent')) {
          return; // the full path is on one trace
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect.fail(
      `no single trace spans the tool-agent path; best trace covered [${[...services].join(', ')}] — ` +
        'expected gateway, orchestrator, cloud-agent',
    );
  });
});
