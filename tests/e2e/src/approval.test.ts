/**
 * Governed-approval E2E slice (Phase 3 item 1). Drives the require-approval
 * gate end to end against the dev stack: submit an R2 write as cli-jane →
 * orchestrator suspends on an ApprovalWorkflow → approve via scripts/approve.mjs
 * as cli-approver → the step executes and the task completes, with the full
 * audit chain. Also pins the negative paths: deny (not executed), the submitter
 * cannot decide (no approvals:decide scope → 403), and a stale subject digest
 * is refused (409). Timeout-deny is NOT here (24h; workflow-tested).
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
import {
  APPROVAL_AGENT_ID,
  APPROVAL_MANIFEST_PATH,
  startApprovalAgent,
  type RunningAgent,
} from './support/approval-agent.js';

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

async function submitWrite(target: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({
      text: `apply governed write to ${target}`,
      capability: 'gov.test_write',
    }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

async function fetchView(
  approvalId: string,
  token: string,
): Promise<{ subject_digest: string; status: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { subject_digest: string; status: string };
}

async function auditEvents(taskId: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

/** Polls the audit stream until an approval.requested for this task appears. */
async function waitForApprovalRequested(taskId: string, timeoutMs = 60_000): Promise<AuditEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = (await auditEvents(taskId)).find((e) => e.event_type === 'approval.requested');
    if (event !== undefined) return event;
    if (Date.now() > deadline) throw new Error(`no approval.requested for ${taskId} in time`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForResult(taskId: string, timeoutMs = 60_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (body.status === 'completed' || body.status === 'failed') return body.result!;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Runs scripts/approve.mjs and returns its combined output + exit code. */
function runApproveCli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/approve.mjs', ...args], { cwd: repoRoot });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, out });
    });
  });
}

beforeAll(async () => {
  platform = await startPlatform();
  const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
  await registerAndActivate(
    APPROVAL_MANIFEST_PATH,
    APPROVAL_AGENT_ID,
    writeToken,
    'approval E2E slice',
  );
  agent = await startApprovalAgent();
}, 300_000);

afterAll(async () => {
  await agent?.shutdown();
  stopPlatform(platform);
});

describe('governed approval slice', () => {
  it('approve via the CLI: the write runs only after a human grants, with the full audit chain', async () => {
    const taskId = await submitWrite('record-42');
    const requested = await waitForApprovalRequested(taskId);
    const approvalId = (requested.details as { approval_id: string }).approval_id;
    // The request carries the full replayable context.
    expect((requested.details as { capability: string }).capability).toBe('gov.test_write');
    expect((requested.details as { plan?: unknown }).plan).toBeDefined();

    // Approve through the CLI (show-first is built in): as cli-approver.
    const { code, out } = await runApproveCli(['approve', approvalId]);
    expect(out, out).toContain('subject_digest');
    expect(out).toContain('gov.test_write');
    expect(code, out).toBe(0);
    expect(out).toContain('APPROVED');

    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');

    // Audit chain: require-approval decision → requested → granted (by the
    // approver) → brokered with grounds → dispatched.
    const events = await auditEvents(taskId);
    const type = (t: string) => events.find((e) => e.event_type === t);
    const policyGate = events.find(
      (e) =>
        e.event_type === 'policy.decision' && e.reason?.policy?.decision === 'require-approval',
    );
    expect(policyGate, 'a require-approval policy.decision').toBeDefined();
    expect(type('approval.requested')).toBeDefined();
    const granted = type('approval.granted');
    expect(granted?.actor.principal).toBe('user:approver.ops');
    const brokered = type('token.brokered');
    expect((brokered?.details as { approval?: unknown }).approval).toBeDefined();
    const dispatched = type('step.dispatched');
    expect((dispatched?.details as { approval_id?: string }).approval_id).toBe(approvalId);
  }, 120_000);

  it('deny: the step is not executed and the task fails honestly', async () => {
    const taskId = await submitWrite('record-99');
    const requested = await waitForApprovalRequested(taskId);
    const approvalId = (requested.details as { approval_id: string }).approval_id;

    const approver = await approverToken();
    const view = await fetchView(approvalId, approver);
    const res = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
      body: JSON.stringify({
        decision: 'deny',
        subject_digest: view.subject_digest,
        note: 'blast radius too wide',
      }),
    });
    expect(res.status).toBe(202);

    const result = await waitForResult(taskId);
    expect(result.status).toBe('failed');
    const events = await auditEvents(taskId);
    expect(events.some((e) => e.event_type === 'approval.denied')).toBe(true);
    // The step never executed: no step.completed for the gated capability.
    expect(events.some((e) => e.event_type === 'step.completed')).toBe(false);
    expect(JSON.stringify(result.error ?? {})).toContain('not executed');
  }, 120_000);

  it('the submitter cannot decide their own approval (no approvals:decide scope → 403)', async () => {
    const taskId = await submitWrite('record-7');
    const requested = await waitForApprovalRequested(taskId);
    const approvalId = (requested.details as { approval_id: string }).approval_id;

    // cli-jane holds task:submit, NOT approvals:decide.
    const jane = await janeToken();
    const get = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${jane}` },
    });
    expect(get.status).toBe(403);
    const post = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jane}` },
      body: JSON.stringify({ decision: 'approve', subject_digest: `sha256:${'0'.repeat(64)}` }),
    });
    expect(post.status).toBe(403);

    // Clean up: approve it so the task doesn't linger for 24h (as approver).
    const approver = await approverToken();
    const view = await fetchView(approvalId, approver);
    await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
      body: JSON.stringify({ decision: 'approve', subject_digest: view.subject_digest }),
    });
    await waitForResult(taskId);
  }, 120_000);

  it('a stale subject digest is refused (409)', async () => {
    const taskId = await submitWrite('record-8');
    const requested = await waitForApprovalRequested(taskId);
    const approvalId = (requested.details as { approval_id: string }).approval_id;

    const approver = await approverToken();
    const res = await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
      body: JSON.stringify({ decision: 'approve', subject_digest: `sha256:${'b'.repeat(64)}` }),
    });
    expect(res.status).toBe(409);

    // Clean up with the correct digest.
    const view = await fetchView(approvalId, approver);
    await fetch(`${GATEWAY_URL}/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${approver}` },
      body: JSON.stringify({ decision: 'approve', subject_digest: view.subject_digest }),
    });
    await waitForResult(taskId);
  }, 120_000);
});
