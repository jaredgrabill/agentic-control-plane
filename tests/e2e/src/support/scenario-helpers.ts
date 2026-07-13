/**
 * Shared HTTP helpers for the Phase 4 DoD acceptance-scenario E2E files
 * (scenario-*.test.ts). These are the same token / task / audit clones the
 * feature E2E files (netsec-agent, governed-writes, orchestrator-v1) each
 * define locally, factored out because the five scenario files exercise the
 * identical control path (a context.sequence task + its audit trail). No test
 * state lives here — every helper is a pure request against the running dev
 * stack, correlated by task_id.
 */

import type { AuditEvent, TaskResult } from '@acp/protocol';
import { expect } from 'vitest';
import { AUDIT_URL, GATEWAY_URL, TOKEN_URL } from './platform.js';

export async function getToken(
  clientId: string,
  clientSecret: string,
  audience: string,
  scope?: string,
): Promise<string> {
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

export const janeToken = (): Promise<string> =>
  getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
export const approverToken = (): Promise<string> =>
  getToken('cli-approver', 'approver-dev-secret', 'acp:gateway', 'approvals:decide');
export const ciToken = (audience: string, scope: string): Promise<string> =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);

/** Submit a context.sequence task (positional inputs) as cli-jane. Returns the task_id. */
export async function submitSequence(
  sequence: string[],
  inputs: Record<string, unknown>[],
  text = 'phase 4 acceptance scenario',
): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text, context: { sequence, inputs } }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

export async function waitForResult(taskId: string, timeoutMs = 120_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (['completed', 'failed', 'cancelled', 'partial'].includes(body.status) && body.result) {
      return body.result;
    }
    if (Date.now() > deadline)
      throw new Error(`task ${taskId} still ${body.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Audit events for a task. The shared stream returns the OLDEST `limit` events
 * (ORDER BY occurred_at ASC), so filter server-side by event_type when a shared
 * high-volume event is what you want, and lift the limit.
 */
export async function auditEvents(
  taskId: string,
  tenant = 'acme',
  eventType?: string,
): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const params = new URLSearchParams({ tenant, task_id: taskId, limit: '1000' });
  if (eventType !== undefined) params.set('event_type', eventType);
  const res = await fetch(`${AUDIT_URL}/v1/events?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

/** Poll the task's audit trail until `ready` is satisfied (or the deadline). */
export async function pollAudit(
  taskId: string,
  ready: (events: AuditEvent[]) => boolean,
  timeoutMs = 90_000,
): Promise<AuditEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let events: AuditEvent[] = [];
  for (;;) {
    events = await auditEvents(taskId);
    if (ready(events)) return events;
    if (Date.now() > deadline) return events;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Grant one approval by id (fetches the subject_digest the decision must echo). */
export async function approve(approvalId: string): Promise<void> {
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

/**
 * Drive a governed saga with more than one gated write: approve each distinct
 * approval.requested as it appears, until `expected` grants are made or the
 * task terminates. The gated writes are sequential, so requests arrive one at a
 * time; a set of granted ids keeps this idempotent under audit replay.
 */
export async function driveApprovals(
  taskId: string,
  expected: number,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const granted = new Set<string>();
  while (granted.size < expected) {
    const requests = (await auditEvents(taskId)).filter(
      (e) => e.event_type === 'approval.requested',
    );
    for (const req of requests) {
      const id = (req.details as { approval_id?: string }).approval_id;
      if (id !== undefined && !granted.has(id)) {
        await approve(id);
        granted.add(id);
      }
    }
    if (granted.size >= expected) return;
    if (Date.now() > deadline)
      throw new Error(`only ${granted.size}/${expected} approvals granted for ${taskId}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
