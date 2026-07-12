/**
 * Governed writes E2E slice (Phase 3 item 3). Drives the first REAL gated tool
 * writes end to end against the dev stack, asserting mock state via direct MCP
 * calls to the itsm mock (:7303) and the cloud mock (:7301):
 *   1. Gated ITSM write: [change.submit CHG-1001] → approve → the itsm mock
 *      shows CHG-1001 submitted; the audit chain runs policy.decision
 *      (require-approval) → approval.granted → token.brokered (capability +
 *      approval grounds) → tool.called (itsm/change_submit, ok, allow).
 *   2. Real-tool unwind: [change.submit CHG-1004, gov.test_fail] → approve →
 *      the write executes → gov.test_fail fails → the saga unwinds, calling
 *      change.withdraw with the {original} handle → the mock shows CHG-1004
 *      withdrawn; the compensator's tool.called carries compensation grounds.
 *   3. Honest tag inverse: [cloud.tag_apply, gov.test_fail] on a resource with
 *      a pre-existing owner tag → after the unwind the overwritten tag is
 *      restored (not deleted) via cloud.tag_restore's restore-previous-value.
 *   4. Risk laundering live: a forged agent-context acp:tools token with no
 *      capability claim, and a direct cli-jane acp:tools token, are BOTH refused
 *      at change_submit — a mutation cannot execute outside the governed path.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { McpToolClient, type ToolResponse } from '@acp/tool-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_AGENT_ID,
  APPROVAL_MANIFEST_PATH,
  startApprovalAgent,
  type RunningAgent,
} from './support/approval-agent.js';
import {
  AUDIT_URL,
  GATEWAY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const TOOL_GATEWAY_URL = 'http://localhost:7106';
const ITSM_MOCK_URL = 'http://localhost:7303/mcp';
const CLOUD_MOCK_URL = 'http://localhost:7301/mcp';

let platform: ChildProcess;
let govAgent: RunningAgent | undefined;

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

async function submitSequence(
  sequence: string[],
  inputs: Record<string, unknown>[],
): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text: 'governed write sequence', context: { sequence, inputs } }),
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

async function waitForResult(taskId: string, timeoutMs = 120_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (['completed', 'failed', 'cancelled'].includes(body.status) && body.result)
      return body.result;
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

async function approveWhenRequested(taskId: string): Promise<void> {
  const requested = await waitForEvent(taskId, 'approval.requested');
  await approve((requested.details as { approval_id: string }).approval_id);
}

// --- direct mock MCP clients (no gateway, no auth) — the state oracle ---

const itsmMock = new McpToolClient({ servers: { itsm: { url: ITSM_MOCK_URL } } });
const cloudMock = new McpToolClient({ servers: { 'cloud-estate': { url: CLOUD_MOCK_URL } } });

async function changeStatus(changeId: string): Promise<string> {
  const res = await itsmMock.call('itsm', 'change_get', { change_id: changeId });
  return (res.data.change as { status: string }).status;
}

async function resourceTags(resourceId: string): Promise<Record<string, string>> {
  const res: ToolResponse = await cloudMock.call('cloud-estate', 'inventory_search', {
    service: 'payments-api',
    env: 'prod',
  });
  const resources = res.data.resources as { resource_id: string; tags: Record<string, string> }[];
  const found = resources.find((r) => r.resource_id === resourceId);
  if (found === undefined) throw new Error(`resource ${resourceId} not found in the cloud mock`);
  return found.tags;
}

const gatewayClient = (server: string) =>
  new McpToolClient({ servers: { [server]: { url: `${TOOL_GATEWAY_URL}/mcp/${server}` } } });

interface ToolError {
  errorClass?: string;
  message?: string;
}

async function failureOf(promise: Promise<unknown>): Promise<ToolError> {
  const outcome = await promise.then(
    () => undefined,
    (err: unknown) => err as ToolError,
  );
  expect(outcome, 'expected the tool call to fail').toBeDefined();
  return outcome!;
}

beforeAll(async () => {
  platform = await startPlatform();
  const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
  // The change-agent and cloud-agent workers run in the platform; register +
  // activate all three agents (the gov.test_fail agent is an in-process worker).
  await registerAndActivate(
    join(repoRoot, 'agents', 'change', 'manifest.yaml'),
    'change-agent',
    writeToken,
    'governed-writes E2E slice',
  );
  await registerAndActivate(
    join(repoRoot, 'agents', 'cloud', 'manifest.yaml'),
    'cloud-agent',
    writeToken,
    'governed-writes E2E slice',
  );
  await registerAndActivate(
    APPROVAL_MANIFEST_PATH,
    APPROVAL_AGENT_ID,
    writeToken,
    'governed-writes E2E slice',
  );
  govAgent = await startApprovalAgent();
}, 300_000);

afterAll(async () => {
  await govAgent?.shutdown();
  stopPlatform(platform);
});

describe('governed writes slice', () => {
  it('gated ITSM write: approve change.submit CHG-1001 → the mock shows it submitted', async () => {
    expect(await changeStatus('CHG-1001')).toBe('draft');
    const taskId = await submitSequence(['change.submit'], [{ change_id: 'CHG-1001' }]);
    await approveWhenRequested(taskId);
    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result)).toBe('completed');

    // The REAL ITSM mock now shows the change submitted.
    expect(await changeStatus('CHG-1001')).toBe('submitted');

    // Audit chain: require-approval → granted → token.brokered (capability +
    // approval grounds) → tool.called (itsm/change_submit, ok, allow).
    const events = await auditEvents(taskId);
    expect(events.some((e) => e.event_type === 'approval.granted')).toBe(true);
    const brokered = events.find(
      (e) =>
        e.event_type === 'token.brokered' &&
        (e.details as { capability?: unknown }).capability !== undefined,
    );
    expect(brokered, 'a token.brokered event must carry capability grounds').toBeDefined();
    expect((brokered!.details as { capability: { risk: string } }).capability.risk).toBe('R2');
    const toolCalled = events.find(
      (e) =>
        e.event_type === 'tool.called' &&
        (e.details as { tool?: string }).tool === 'change_submit',
    );
    expect(toolCalled, 'a tool.called for change_submit must exist').toBeDefined();
    expect((toolCalled!.details as { outcome: string }).outcome).toBe('ok');
    expect(toolCalled!.reason?.policy?.decision).toBe('allow');
  }, 180_000);

  it('real-tool unwind: the submit executes, the dependent fails, change.withdraw unwinds it', async () => {
    expect(await changeStatus('CHG-1004')).toBe('draft');
    const taskId = await submitSequence(
      ['change.submit', 'gov.test_fail'],
      [{ change_id: 'CHG-1004' }, {}],
    );
    await approveWhenRequested(taskId);
    const result = await waitForResult(taskId);

    // The saga unwound the submit: the mock shows CHG-1004 withdrawn.
    expect(result.compensation, JSON.stringify(result)).toBeDefined();
    expect(result.compensation!.status).toBe('complete');
    expect(result.compensation!.compensated.map((c) => c.compensator)).toEqual(['change.withdraw']);
    expect(await changeStatus('CHG-1004')).toBe('withdrawn');

    // The compensator's tool.called carries compensation grounds (an unwind,
    // not a re-gated write).
    const events = await auditEvents(taskId);
    const withdrawCall = events.find(
      (e) =>
        e.event_type === 'tool.called' &&
        (e.details as { tool?: string }).tool === 'change_withdraw',
    );
    expect(withdrawCall, 'a tool.called for change_withdraw must exist').toBeDefined();
    expect((withdrawCall!.details as { outcome: string }).outcome).toBe('ok');
  }, 180_000);

  it('honest tag inverse: an overwritten tag is restored, not deleted', async () => {
    const before = await resourceTags('i-0a1f001');
    expect(before.owner).toBe('platform-oncall');

    const taskId = await submitSequence(
      ['cloud.tag_apply', 'gov.test_fail'],
      [{ resource_id: 'i-0a1f001', tags: { owner: 'e2e-temp-owner' } }, {}],
    );
    await approveWhenRequested(taskId);
    const result = await waitForResult(taskId);
    expect(result.compensation, JSON.stringify(result)).toBeDefined();
    expect(result.compensation!.status).toBe('complete');
    expect(result.compensation!.compensated.map((c) => c.compensator)).toEqual([
      'cloud.tag_restore',
    ]);

    // The honest inverse restored the PREVIOUS value, not a blind delete.
    const after = await resourceTags('i-0a1f001');
    expect(after.owner).toBe('platform-oncall');
  }, 180_000);

  it('risk laundering live: a forged agent token with no capability claim is refused at change_submit', async () => {
    // Two-hop platform forge (like tool-gateway.test.ts): svc-ci fabricates an
    // acp:tools token acting as agent:change-agent with an orchestrator chain,
    // carrying jane's itsm:change:submit scope — but NO capability claim (the
    // token service rejects a body-supplied one, and the brokered claim only
    // rides the real dispatch). The write is refused: it never brokered through
    // the governed path, so there is no approval grounds and no capability
    // context.
    const subjectToken = await getToken(
      'cli-jane',
      'jane-dev-secret',
      'acp:gateway',
      'task:submit itsm:change:submit',
    );
    const hop1 = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: subjectToken,
        audience: 'acp:orchestrator',
        actor: 'svc:orchestrator',
      }),
    });
    expect(hop1.status, await hop1.clone().text()).toBe(200);
    const hop1Token = ((await hop1.json()) as { access_token: string }).access_token;
    const hop2 = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: hop1Token,
        audience: 'acp:tools',
        scope: 'itsm:change:submit',
        actor: 'agent:change-agent@0.1.0',
      }),
    });
    expect(hop2.status, await hop2.clone().text()).toBe(200);
    const forged = ((await hop2.json()) as { access_token: string }).access_token;

    const before = await changeStatus('CHG-1005');
    const refused = await failureOf(
      gatewayClient('itsm').call(
        'itsm',
        'change_submit',
        { change_id: 'CHG-1005', idempotency_key: 'forge-attempt-1' },
        { delegatedToken: forged },
      ),
    );
    expect(refused.errorClass).toBe('policy_denied');
    // Refused by governance (no approval grounds / no capability context) —
    // either defense blocks it; the state must be untouched.
    expect(await changeStatus('CHG-1005')).toBe(before);
  }, 120_000);

  it('risk laundering live: a direct cli-jane acp:tools token cannot call change_submit', async () => {
    // Jane holds itsm:change:submit and can mint an acp:tools token directly
    // (IDE-shaped), but as a User with no capability context she cannot execute
    // an R2 write — the governed task path is the only door.
    const janeTools = await getToken(
      'cli-jane',
      'jane-dev-secret',
      'acp:tools',
      'itsm:change:submit',
    );
    const before = await changeStatus('CHG-1005');
    const refused = await failureOf(
      gatewayClient('itsm').call(
        'itsm',
        'change_submit',
        { change_id: 'CHG-1005', idempotency_key: 'direct-jane-1' },
        { delegatedToken: janeTools },
      ),
    );
    expect(refused.errorClass).toBe('policy_denied');
    expect(await changeStatus('CHG-1005')).toBe(before);
  }, 120_000);
});
