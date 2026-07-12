/**
 * Phase 2 Item 4 scenario: Orchestrator v1 plans a composite cost-forensics
 * task (no explicit capability), fans out to the cloud and code agents in
 * parallel with per-step brokered tokens (ADR-0007), and synthesizes a
 * sectioned answer — or an honest partial one when a branch is suspended or
 * the budget gates dispatch.
 *
 * Gateway note (unchanged contract): a partial task still arrives as
 * `{status: 'completed', result: {status: 'partial', gaps, ...}}` — the
 * workflow COMPLETED; the RESULT is partial. Clients read `result.status`.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { CURRENT_PRICE_BOOK_VERSION } from '@acp/cost-meter';
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

const execFileAsync = promisify(execFile);

const QUESTION = 'Why did cloud spend jump last week?';
const CONTEXT = { repo: 'acme/payments-service' };

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
const janeToken = () => getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');

async function submitComposite(
  budget?: Record<string, number>,
): Promise<{ task_id: string; status: number }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    // Deliberately NO capability: the rule planner must recognize the
    // cost-forensics shape and compose the plan itself.
    body: JSON.stringify({
      text: QUESTION,
      context: CONTEXT,
      ...(budget === undefined ? {} : { budget }),
    }),
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

async function killSwitch(action: 'suspend' | 'reinstate', agentId: string, reason: string) {
  await execFileAsync(
    'node',
    [join(repoRoot, 'scripts', 'kill-switch.mjs'), action, agentId, '--reason', reason],
    { cwd: repoRoot },
  );
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 2 orchestrator v1 scenario', () => {
  it('registers and activates the knowledge, cloud, and code agents', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'python', 'agents', 'knowledge', 'manifest.yaml'),
      'knowledge-agent',
      writeToken,
      'phase 2 orchestrator v1 scenario',
    );
    await registerAndActivate(
      join(repoRoot, 'agents', 'cloud', 'manifest.yaml'),
      'cloud-agent',
      writeToken,
      'phase 2 orchestrator v1 scenario',
    );
    await registerAndActivate(
      join(repoRoot, 'agents', 'code', 'manifest.yaml'),
      'code-agent',
      writeToken,
      'phase 2 orchestrator v1 scenario',
    );
  });

  let compositeTaskId: string;

  it('composes the cost-forensics answer from both agents without an explicit route', async () => {
    const submitted = await submitComposite();
    expect(submitted.status).toBe(202);
    compositeTaskId = submitted.task_id;

    const result = await waitForResult(compositeTaskId);
    expect(result.status, JSON.stringify(result.error ?? result.gaps ?? {})).toBe('completed');

    // The recorded plan is part of the result: intent, not just outcome.
    expect(result.plan?.planner).toBe('rule-planner@1');
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps.map((s) => s.capability)).toEqual([
      'cloud.cost_analysis',
      'code.ci_health',
    ]);

    // Both sections present: cost attribution AND the CI/deploy correlation.
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('payments-api');
    expect(text).toContain('30.0');
    expect(text).toContain('d-2026-07-01-042');
    expect(text).toContain('pass rate');

    // Citations concatenated across sections, lineage intact.
    const docIds = result.answer!.citations.map((c) => c.doc_id);
    expect(docIds).toContain('cloud/cost-report');
    expect(docIds).toContain('code/ci-activity');
    for (const citation of result.answer!.citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('recorded the plan, both dispatches, and one brokered mint per step in the audit trail', async () => {
    // The audit consumer is asynchronous; give the stream a moment.
    let events: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events = await auditEvents(compositeTaskId);
      if (events.length >= 10) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const count = (type: string) => events.filter((e) => e.event_type === type).length;

    // task.planned lands BEFORE execution, carrying the full plan.
    const planned = events.find((e) => e.event_type === 'task.planned');
    expect(planned, 'no task.planned audit event').toBeDefined();
    const auditedPlan = (planned!.details as { plan?: { steps: { capability: string }[] } }).plan;
    expect(auditedPlan?.steps.map((s) => s.capability)).toEqual([
      'cloud.cost_analysis',
      'code.ci_health',
    ]);

    expect(count('step.dispatched')).toBe(2);
    expect(count('step.completed')).toBe(2);
    expect(count('task.completed')).toBe(1);

    // Cost Meter v0: task.completed carries a priced ledger against the
    // packaged price book. Tool agents are zero-LLM so the total is 0, but
    // the field is present and numeric, and the pinned book version is
    // recorded for reproducibility.
    const taskCompleted = events.find((e) => e.event_type === 'task.completed')!;
    const details = taskCompleted.details as {
      usage_totals?: { cost_usd?: number | null };
      price_book_version?: string | null;
    };
    expect(typeof details.usage_totals?.cost_usd).toBe('number');
    expect(details.usage_totals!.cost_usd!).toBeGreaterThanOrEqual(0);
    expect(details.price_book_version).toBe(CURRENT_PRICE_BOOK_VERSION);

    // ADR-0007: one token.brokered per step, joined to the task and carrying
    // the full user → orchestrator → agent chain.
    const brokered = events.filter((e) => e.event_type === 'token.brokered');
    expect(brokered).toHaveLength(2);
    const actors = new Set<string>();
    for (const mint of brokered) {
      const grounds = (mint.details as { grounds?: { task_id?: string } }).grounds;
      expect(grounds?.task_id).toBe(compositeTaskId);
      const chain = mint.actor.delegation_chain!.map((l) => l.sub);
      expect(chain).toHaveLength(3);
      expect(chain[0]).toBe('user:jane.doe');
      expect(chain[1]).toBe('svc:orchestrator');
      expect(chain[2]).toMatch(/^agent:(cloud|code)-agent@/);
      actors.add(chain[2]!);
    }
    expect(actors.size).toBe(2);
  });

  it('reports an honest partial when the budget gates dispatch after one step', async () => {
    const submitted = await submitComposite({ max_steps: 1 });
    expect(submitted.status).toBe(202);

    const result = await waitForResult(submitted.task_id);
    expect(result.status).toBe('partial');
    expect(result.error?.class).toBe('budget_exhausted');
    expect(result.error?.message).toContain('max_steps 1');
    // The cost step (first in plan order) still answered.
    expect(result.answer!.text.toLowerCase()).toContain('payments-api');
    expect(result.gaps?.[0]).toContain('max_steps 1');
    expect(result.gaps?.[0]).toContain('code.ci_health not executed');
  });

  it('kill switch degrades the composite: the suspended branch is not planned, recovery restores it', async () => {
    // The rule planner is servability-aware (design rule 2): with code-agent
    // suspended BEFORE submission, code.ci_health is not `active` in the
    // registry, so the composite plans around it — kill switch stops new
    // traffic at the planning stage, within seconds. (Suspension AFTER
    // planning is caught by dispatch-time discovery in the step child —
    // the exit-scenario kill-switch test drives that path end to end.)
    await killSwitch('suspend', 'code-agent', 'orchestrator v1 e2e drill');
    try {
      const submitted = await submitComposite();
      expect(submitted.status).toBe(202);

      const result = await waitForResult(submitted.task_id);
      expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
      // Only the cost branch was planned — nothing claims CI health.
      expect(result.plan?.steps.map((s) => s.capability)).toEqual(['cloud.cost_analysis']);
      const text = result.answer!.text.toLowerCase();
      expect(text).toContain('payments-api');
      expect(text).toContain('30.0');
      expect(text).not.toContain('pass rate');
      expect(result.answer!.citations.some((c) => c.doc_id === 'cloud/cost-report')).toBe(true);
      expect(result.answer!.citations.some((c) => c.doc_id === 'code/ci-activity')).toBe(false);
    } finally {
      // Reinstate so repeated local runs start from a clean state.
      await killSwitch('reinstate', 'code-agent', 'orchestrator v1 e2e drill complete');
    }

    // Recovery: the reinstated branch is planned again.
    const recovered = await submitComposite();
    const result = await waitForResult(recovered.task_id);
    expect(result.status).toBe('completed');
    expect(result.plan?.steps.map((s) => s.capability)).toEqual([
      'cloud.cost_analysis',
      'code.ci_health',
    ]);
  });
});
