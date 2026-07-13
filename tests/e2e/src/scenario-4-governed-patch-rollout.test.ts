/**
 * DoD acceptance scenario 4 — Governed patch rollout with a saga unwind. The
 * remediation for the critical CVE runs as a four-step context.sequence:
 *   netsec.exposure_analysis (R0) · change.submit (R2) · cloud.tag_apply (R2) ·
 *   gov.test_fail (injected failure)
 * Both R2 writes are human-approved and execute for real (CHG-4001 submitted,
 * the patch tag applied). The injected failure then triggers a saga unwind that
 * runs each write's declared compensator in REVERSE write order —
 * [cloud.tag_restore, change.withdraw] — so the change is withdrawn and the tag
 * restored to its prior value. The result carries honest gaps and the full
 * approval + compensation audit. Reuses the in-process approval worker
 * (support/approval-agent.ts) that serves gov.test_fail.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { McpToolClient, type ToolResponse } from '@acp/tool-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_AGENT_ID,
  APPROVAL_MANIFEST_PATH,
  startApprovalAgent,
  type RunningAgent,
} from './support/approval-agent.js';
import { registerAndActivate, repoRoot, startPlatform, stopPlatform } from './support/platform.js';
import {
  ciToken,
  driveApprovals,
  pollAudit,
  submitSequence,
  waitForResult,
} from './support/scenario-helpers.js';

const ITSM_MOCK_URL = 'http://localhost:7303/mcp';
const CLOUD_MOCK_URL = 'http://localhost:7301/mcp';
const CHANGE_ID = 'CHG-4001';
const RESOURCE_ID = 'i-0a1f001';

const SEQUENCE = ['netsec.exposure_analysis', 'change.submit', 'cloud.tag_apply', 'gov.test_fail'];

let platform: ChildProcess;
let govAgent: RunningAgent | undefined;

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

beforeAll(async () => {
  platform = await startPlatform();
  const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
  for (const [dir, id] of [
    ['agents/netsec', 'netsec-agent'],
    ['agents/change', 'change-agent'],
    ['agents/cloud', 'cloud-agent'],
  ] as const) {
    await registerAndActivate(
      join(repoRoot, ...dir.split('/'), 'manifest.yaml'),
      id,
      writeToken,
      'scenario 4 governed patch rollout',
    );
  }
  await registerAndActivate(
    APPROVAL_MANIFEST_PATH,
    APPROVAL_AGENT_ID,
    writeToken,
    'scenario 4 governed patch rollout',
  );
  govAgent = await startApprovalAgent();
}, 300_000);

afterAll(async () => {
  await govAgent?.shutdown();
  stopPlatform(platform);
});

describe('scenario 4 — governed patch rollout saga unwind', () => {
  let taskId: string;
  let before: Record<string, string>;

  it('approves both R2 writes, executes them, then unwinds the whole saga on the injected failure', async () => {
    // Pre-state: the change is a draft, the resource has no patch tag.
    expect(await changeStatus(CHANGE_ID)).toBe('draft');
    before = await resourceTags(RESOURCE_ID);
    expect(before.patch).toBeUndefined();

    taskId = await submitSequence(SEQUENCE, [
      { service: 'payments-api' },
      { change_id: CHANGE_ID },
      { resource_id: RESOURCE_ID, tags: { patch: 'CVE-2026-31337-applied' } },
      {},
    ]);

    // Two gated writes → two approvals (netsec R0 needs none, gov.test_fail is
    // not a gated write). Grant each as it is requested.
    await driveApprovals(taskId, 2);

    const result = await waitForResult(taskId);

    // The injected failure did NOT leave a completed task — it is an honest
    // failure/partial with gaps, not a silent success.
    expect(['failed', 'partial'], JSON.stringify(result)).toContain(result.status);
    expect(result.gaps ?? result.error, JSON.stringify(result)).toBeDefined();

    // The saga unwound BOTH writes, in reverse write order.
    expect(result.compensation, JSON.stringify(result)).toBeDefined();
    expect(result.compensation!.status).toBe('complete');
    expect(result.compensation!.compensated.map((c) => c.compensator)).toEqual([
      'cloud.tag_restore',
      'change.withdraw',
    ]);

    // The systems of record are back to their prior state: change withdrawn,
    // tag restored (the newly-added patch key removed, not left dangling).
    expect(await changeStatus(CHANGE_ID)).toBe('withdrawn');
    expect(await resourceTags(RESOURCE_ID)).toEqual(before);
  }, 300_000);

  it('recorded two approval grants, both R2 writes, and the compensation in the audit trail', async () => {
    const events = await pollAudit(taskId, (evs) =>
      evs.some((e) => e.event_type === 'compensation.completed'),
    );

    // Two distinct gated writes were each approved.
    const grants = events.filter((e) => e.event_type === 'approval.granted');
    expect(grants.length).toBeGreaterThanOrEqual(2);

    // Both R2 writes actually executed through the gateway PEP before the unwind.
    const toolCalls = events.filter((e) => e.event_type === 'tool.called');
    const forward = toolCalls
      .map((e) => (e.details as { tool?: string }).tool)
      .filter((t): t is string => t !== undefined);
    expect(forward).toContain('change_submit');
    expect(forward).toContain('tag_apply');

    // And both compensators ran as tool calls during the unwind.
    expect(forward).toContain('change_withdraw');
    expect(forward).toContain('tag_remove');

    // The compensation completed on the audit stream (not just in the result).
    expect(events.some((e) => e.event_type === 'compensation.completed')).toBe(true);
  }, 120_000);
});
