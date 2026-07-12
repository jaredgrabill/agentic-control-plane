/**
 * Compensation E2E slice (Phase 3 item 2). Drives the saga unwind end to end
 * against the dev stack, extending the item-1 approval-test-agent with a mutual
 * compensator pair (gov.test_write ⇄ gov.test_undo) and an always-failing R0
 * (gov.test_fail):
 *   1. Governed unwind: a sequence [gov.test_write, gov.test_fail] is approved;
 *      the write executes; gov.test_fail fails → the orchestrator unwinds,
 *      calling gov.test_undo with the {original} write context, and reports a
 *      compensation block (status complete) plus the full audit chain.
 *   2. Cancel mid-approval: cancelling while the approval is pending yields a
 *      cancelled task with NO compensation events and a task.cancel_requested
 *      audit (nothing executed, nothing to unwind).
 *   3. Registration negative: a dangling compensator is rejected at register.
 */

import type { AuditEvent, TaskResult } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  REGISTRY_URL,
  TOKEN_URL,
  registerAndActivate,
  startPlatform,
  stopPlatform,
} from './support/platform.js';
import {
  APPROVAL_AGENT_ID,
  APPROVAL_MANIFEST_PATH,
  startApprovalAgent,
  type RunningAgent,
} from './support/approval-agent.js';
import type { ChildProcess } from 'node:child_process';

let platform: ChildProcess;
let agent: RunningAgent | undefined;

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

const janeToken = () => getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
const approverToken = () =>
  getToken('cli-approver', 'approver-dev-secret', 'acp:gateway', 'approvals:decide');
const ciToken = (audience: string, scope: string) =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);

/** Submits a governed sequence: gov.test_write (approval) then a dependent step. */
async function submitSequence(sequence: string[], inputs: Record<string, unknown>[]): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({
      text: 'governed compensation sequence',
      context: { sequence, inputs },
    }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

async function submitWrite(target: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text: `apply governed write to ${target}`, capability: 'gov.test_write' }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

async function auditEvents(taskId: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

async function waitForEvent(taskId: string, type: string, timeoutMs = 60_000): Promise<AuditEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = (await auditEvents(taskId)).find((e) => e.event_type === type);
    if (event !== undefined) return event;
    if (Date.now() > deadline) throw new Error(`no ${type} for ${taskId} in time`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForResult(taskId: string, timeoutMs = 90_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (['completed', 'failed', 'cancelled'].includes(body.status) && body.result) return body.result;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function approve(approvalId: string): Promise<void> {
  const approver = await approverToken();
  const view = (await (
    await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${approver}` },
    })
  ).json()) as { subject_digest: string };
  const res = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
    body: JSON.stringify({ decision: 'approve', subject_digest: view.subject_digest }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
}

beforeAll(async () => {
  platform = await startPlatform();
  const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
  await registerAndActivate(
    APPROVAL_MANIFEST_PATH,
    APPROVAL_AGENT_ID,
    writeToken,
    'compensation E2E slice',
  );
  agent = await startApprovalAgent();
}, 300_000);

afterAll(async () => {
  await agent?.shutdown();
  stopPlatform(platform);
});

describe('compensation slice', () => {
  it('governed unwind: approve the write, the dependent fails, the compensator runs with {original}', async () => {
    const taskId = await submitSequence(
      ['gov.test_write', 'gov.test_fail'],
      [{ target: 'record-42' }, {}],
    );
    const requested = await waitForEvent(taskId, 'approval.requested');
    const approvalId = (requested.details as { approval_id: string }).approval_id;
    await approve(approvalId);

    const result = await waitForResult(taskId);
    // The plan is partial (gov.test_fail failed) and the write was unwound.
    expect(result.compensation, JSON.stringify(result)).toBeDefined();
    expect(result.compensation!.status).toBe('complete');
    expect(result.compensation!.trigger).toBe('step_failure');
    expect(result.compensation!.compensated.map((c) => c.compensator)).toEqual(['gov.test_undo']);

    // gov.test_undo ran with the ORIGINAL write context (mechanically derived).
    const undo = agent!.calls.find((c) => c.capability === 'gov.test_undo');
    expect(undo, JSON.stringify(agent!.calls)).toBeDefined();
    const original = (undo!.input as { original?: Record<string, unknown> }).original;
    expect(original?.capability).toBe('gov.test_write');
    expect(original?.step_id).toBeDefined();

    // Audit chain: granted → step.completed(write) → compensation.started →
    // step.dispatched(compensation) + token.brokered(compensation grounds) →
    // compensation.completed → task.completed.
    const events = await auditEvents(taskId);
    const type = (t: string) => events.findIndex((e) => e.event_type === t);
    expect(type('approval.granted')).toBeGreaterThanOrEqual(0);
    expect(type('compensation.started')).toBeGreaterThan(type('approval.granted'));
    expect(type('compensation.completed')).toBeGreaterThan(type('compensation.started'));
    // A step.dispatched carrying compensation details exists, and a
    // token.brokered carrying compensation grounds exists.
    expect(
      events.some(
        (e) =>
          e.event_type === 'step.dispatched' &&
          (e.details as { compensation?: unknown }).compensation !== undefined,
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event_type === 'token.brokered' &&
          (e.details as { compensation?: unknown }).compensation !== undefined,
      ),
    ).toBe(true);
    const completed = events.find((e) => e.event_type === 'compensation.completed');
    expect((completed!.details as { status: string }).status).toBe('complete');
  }, 180_000);

  it('cancel mid-approval: cancelled, no compensation events, task.cancel_requested audited', async () => {
    const taskId = await submitWrite('record-cancel');
    await waitForEvent(taskId, 'approval.requested');

    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
      body: JSON.stringify({ reason: 'compensation E2E cancel' }),
    });
    expect(res.status, await res.clone().text()).toBe(202);

    const result = await waitForResult(taskId);
    expect(result.status).toBe('cancelled');
    expect(result.compensation).toBeUndefined();

    const events = await auditEvents(taskId);
    expect(events.some((e) => e.event_type === 'task.cancel_requested')).toBe(true);
    expect(events.some((e) => String(e.event_type).startsWith('compensation.'))).toBe(false);
    // Nothing executed: no step.completed for the gated write.
    expect(events.some((e) => e.event_type === 'step.completed')).toBe(false);
  }, 180_000);

  it('registration negative: a dangling compensator is rejected (400)', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write');
    const res = await fetch(`${REGISTRY_URL}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({
        version: '0.1.0',
        manifest: {
          id: 'dangling-comp-agent',
          name: 'Dangling Compensator Agent',
          owner: 'team-platform',
          description: 'An R2 write whose compensator does not exist in the manifest.',
          capabilities: [
            {
              name: 'gov.orphan_write',
              description: 'A governed write naming a compensator that is not declared.',
              risk: 'R2',
              compensator: 'gov.nonexistent_undo',
              input_schema: { type: 'object' },
              output_schema: { type: 'object' },
              examples: [{ input: {} }, { input: {} }, { input: {} }],
            },
          ],
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('not a capability');
  }, 60_000);
});
