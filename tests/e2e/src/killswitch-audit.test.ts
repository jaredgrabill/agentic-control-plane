/**
 * Kill-switch tiers 2-3 + Audit v1 E2E slice (Phase 3 item 5). Drives the whole
 * item against the dev stack, reusing the approval-test-agent (gov.test_write R2
 * ⇄ gov.test_undo, plus gov.test_slow_fail for the mid-flight exemption window):
 *
 *  1. Tier-2 named: suspending gov.test_write fails the step closed (naming the
 *     switch, NO approval) with an audited killswitch.activated{tier:capability};
 *     reinstating restores the governed flow.
 *  2. Tier-2 risk + exemption mid-flight: a risk-R2 halt activated AFTER the
 *     write completed still lets the ensuing unwind's R2 compensator run
 *     (exemption matrix); a fresh gov.test_write is blocked pre-approval.
 *  3. Tier-3 fleet: a task parked on approval is auto-cancelled (task.cancel_
 *     requested{trigger:fleet_killswitch}); new intake is 503; resume recovers.
 *  4. Integrity: GET /v1/verify for acme AND platform → verified true.
 *  5. Tamper drill (security-negative, run last): the append-only + chain_check
 *     triggers refuse mutation and forged linkage; a mutation with the trigger
 *     dropped is caught by /v1/verify as hash_mismatch.
 *  6. Reconstruction: a completed governed task reconstructs into an ordered
 *     narrative with the delegation chain + integrity span; CLI smoke.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { sha256Digest, stableStringify } from '@acp/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  REGISTRY_URL,
  TOKEN_URL,
  repoRoot,
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

let platform: ChildProcess;
let agent: RunningAgent | undefined;

const GENESIS_PREV_HASH = `sha256:${'0'.repeat(64)}`;
const DB_URL = process.env.ACP_DATABASE_URL ?? 'postgres://acp:acp-dev-password@localhost:5432/acp';

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
const adminToken = () => ciToken('acp:registry', 'registry:admin');

/** Flips a tier-2/3 kill switch via the registry's audited route. */
async function flip(path: string, active: boolean, reason: string): Promise<void> {
  const res = await fetch(`${REGISTRY_URL}/v1/killswitch/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminToken()}` },
    body: JSON.stringify({ active, reason }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
}

async function submit(body: Record<string, unknown>): Promise<{ status: number; taskId?: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) return { status: res.status };
  return { status: 202, taskId: ((await res.json()) as { task_id: string }).task_id };
}

async function submitWrite(target: string): Promise<string> {
  const r = await submit({ text: `write ${target}`, capability: 'gov.test_write' });
  expect(r.status, 'expected 202 for a write submission').toBe(202);
  return r.taskId!;
}

async function auditEvents(taskId: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&task_id=${taskId}&limit=1000`, {
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
    await new Promise((r) => setTimeout(r, 800));
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

async function verifyChain(tenant: string): Promise<{
  verified: boolean;
  records_checked: number;
  failure?: { kind: string; chain_seq: number };
}> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/verify?tenant=${tenant}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as {
    verified: boolean;
    records_checked: number;
    failure?: { kind: string; chain_seq: number };
  };
}

beforeAll(async () => {
  platform = await startPlatform();
  const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
  await registerAndActivate(
    APPROVAL_MANIFEST_PATH,
    APPROVAL_AGENT_ID,
    writeToken,
    'killswitch-audit E2E',
  );
  agent = await startApprovalAgent();
}, 300_000);

afterAll(async () => {
  // Best-effort: clear any flags this slice may have left active.
  await flip('risk/R2', false, 'e2e cleanup').catch(() => undefined);
  await flip('capability/gov.test_write', false, 'e2e cleanup').catch(() => undefined);
  await flip('fleet', false, 'e2e cleanup').catch(() => undefined);
  await agent?.shutdown();
  stopPlatform(platform);
});

describe('kill switch tiers 2-3 + audit integrity', () => {
  it('tier 2 named-capability: fails the write closed (no approval), audited, then reinstates', async () => {
    await flip('capability/gov.test_write', true, 'e2e named suspend');

    // Under the named flag the write is refused pre-approval — an honest gap
    // naming the switch, and NO approval was ever requested.
    const blockedTask = await submitWrite('record-named');
    const blocked = await waitForResult(blockedTask);
    expect(blocked.status).not.toBe('completed');
    expect(JSON.stringify(blocked.gaps)).toMatch(/kill switch/i);
    const blockedEvents = await auditEvents(blockedTask);
    expect(blockedEvents.some((e) => e.event_type === 'approval.requested')).toBe(false);

    // The activation is audited on the platform tenant with tier/target.
    const platformToken = await ciToken('acp:audit', 'audit:read');
    const platformEvents = (await (
      await fetch(
        `${AUDIT_URL}/v1/events?tenant=platform&event_type=killswitch.activated&limit=1000`,
        { headers: { authorization: `Bearer ${platformToken}` } },
      )
    ).json()) as { events: AuditEvent[] };
    expect(
      platformEvents.events.some(
        (e) =>
          (e.details as { tier?: string; target?: string }).tier === 'capability' &&
          (e.details as { target?: string }).target === 'gov.test_write',
      ),
    ).toBe(true);

    // Reinstate → the governed flow works again (approval → completed).
    await flip('capability/gov.test_write', false, 'e2e named reinstate');
    const okTask = await submitWrite('record-named-ok');
    const requested = await waitForEvent(okTask, 'approval.requested');
    await approve((requested.details as { approval_id: string }).approval_id);
    const ok = await waitForResult(okTask);
    expect(ok.status, JSON.stringify(ok)).toBe('completed');
  }, 240_000);

  it('tier 2 risk: a mid-flight R2 halt exempts the unwind compensator and blocks a fresh write', async () => {
    // A sequence: R2 write (approved) then a slow R0 that fails. The slow sleep
    // is the window to activate the R2 halt after the write completes.
    const r = await submit({
      text: 'risk exemption sequence',
      context: {
        sequence: ['gov.test_write', 'gov.test_slow_fail'],
        inputs: [{ target: 'r2' }, { sleep_ms: 8000 }],
      },
    });
    expect(r.status).toBe(202);
    const taskId = r.taskId!;

    const requested = await waitForEvent(taskId, 'approval.requested');
    await approve((requested.details as { approval_id: string }).approval_id);
    // Wait for the R2 write to COMPLETE, then halt risk R2 while the slow step sleeps.
    await waitForEvent(taskId, 'step.completed');
    await flip('risk/R2', true, 'e2e mid-flight risk halt');

    try {
      // A FRESH gov.test_write is now blocked pre-approval (non-compensation).
      const freshTask = await submitWrite('record-blocked-by-risk');
      const fresh = await waitForResult(freshTask);
      expect(fresh.status).not.toBe('completed');
      expect(JSON.stringify(fresh.gaps)).toMatch(/kill switch/i);
      expect(
        (await auditEvents(freshTask)).some((e) => e.event_type === 'approval.requested'),
      ).toBe(false);

      // The in-flight task's slow step fails → the R2 write is unwound. The
      // compensator (gov.test_undo, R2) is EXEMPT from the R2 halt → it runs and
      // compensation completes.
      const result = await waitForResult(taskId);
      expect(result.compensation, JSON.stringify(result)).toBeDefined();
      expect(result.compensation!.status).toBe('complete');
      expect(result.compensation!.compensated.map((c) => c.compensator)).toContain('gov.test_undo');
      expect(agent!.calls.some((c) => c.capability === 'gov.test_undo')).toBe(true);
    } finally {
      await flip('risk/R2', false, 'e2e risk reinstate');
    }
  }, 300_000);

  it('tier 3 fleet: parks on approval, halt auto-cancels it, intake 503s, resume recovers', async () => {
    const taskId = await submitWrite('record-fleet');
    await waitForEvent(taskId, 'approval.requested');

    await flip('fleet', true, 'e2e fleet halt');
    try {
      // The parked task is auto-cancelled by the fleet canceller.
      const result = await waitForResult(taskId);
      expect(result.status).toBe('cancelled');
      const events = await auditEvents(taskId);
      const cancel = events.find((e) => e.event_type === 'task.cancel_requested');
      expect(cancel, 'task.cancel_requested not emitted').toBeDefined();
      expect((cancel!.details as { trigger?: string }).trigger).toBe('fleet_killswitch');

      // New intake is refused with 503 while the fleet is halted.
      const rejected = await submit({ text: 'during halt', capability: 'gov.test_write' });
      expect(rejected.status).toBe(503);
    } finally {
      await flip('fleet', false, 'e2e fleet resume');
    }

    // After resume, intake works again.
    const recovered = await submit({ text: 'after resume', capability: 'gov.test_write' });
    expect(recovered.status).toBe(202);
  }, 240_000);

  it('audit integrity: the acme and platform chains verify', async () => {
    const acme = await verifyChain('acme');
    expect(acme.verified, JSON.stringify(acme)).toBe(true);
    expect(acme.records_checked).toBeGreaterThan(0);

    const platform = await verifyChain('platform');
    expect(platform.verified, JSON.stringify(platform)).toBe(true);
    expect(platform.records_checked).toBeGreaterThan(0);
  }, 120_000);

  it('reconstruction: a completed governed task assembles into an ordered narrative + CLI smoke', async () => {
    const taskId = await submitWrite('record-reconstruct');
    const requested = await waitForEvent(taskId, 'approval.requested');
    await approve((requested.details as { approval_id: string }).approval_id);
    await waitForResult(taskId);

    const token = await ciToken('acp:audit', 'audit:read');
    const res = await fetch(`${AUDIT_URL}/v1/tasks/${taskId}/reconstruction?tenant=acme`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const recon = (await res.json()) as {
      task_id: string;
      integrity: { records: number; span: { from_seq: number; to_seq: number } };
      submitted?: { actor: string };
      steps: { capability?: string; approval?: { status: string }; agent?: { id?: string } }[];
      outcome?: { status: string };
      timeline: { event_type: string }[];
    };
    expect(recon.task_id).toBe(taskId);
    expect(recon.integrity.records).toBeGreaterThan(0);
    expect(recon.integrity.span.to_seq).toBeGreaterThanOrEqual(recon.integrity.span.from_seq);
    expect(recon.submitted?.actor).toContain('jane');
    const writeStep = recon.steps.find((s) => s.capability === 'gov.test_write');
    expect(writeStep, JSON.stringify(recon.steps)).toBeDefined();
    expect(writeStep!.approval?.status).toBe('granted');
    expect(writeStep!.agent?.id).toBe(APPROVAL_AGENT_ID);
    expect(recon.timeline[0]!.event_type).toBe('task.submitted');

    // CLI smoke: the operator tool exits 0 and prints the task.
    const cli = spawnSync(
      'node',
      [join(repoRoot, 'scripts', 'reconstruct-task.mjs'), taskId, '--tenant', 'acme'],
      { encoding: 'utf8', env: process.env },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain(taskId);
  }, 240_000);

  it('tamper drill (security-negative): triggers refuse mutation + forged linkage; verify catches a mutation', async () => {
    // Self-contained on a throwaway tenant so acme/platform chains stay intact.
    const tenant = `ksdrill${Math.floor(Math.random() * 1e6)}`;
    const pool = new pg.Pool({ connectionString: DB_URL });
    const recordHash = (chainSeq: number, prevHash: string, event: unknown): string =>
      sha256Digest(
        stableStringify({
          v: 'acp-audit-chain/v1',
          tenant,
          chain_seq: chainSeq,
          prev_hash: prevHash,
          event,
        }),
      );
    const mkEvent = (): AuditEvent => ({
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      tenant,
      event_type: 'tool.called',
      actor: { principal: 'svc:test' },
      action: { name: 'x' },
    });

    try {
      // Seed three properly-chained rows (the chain_check trigger validates them).
      const rows: { id: string; seq: number; prev: string; hash: string; event: AuditEvent }[] = [];
      let prev = GENESIS_PREV_HASH;
      for (let seq = 1; seq <= 3; seq += 1) {
        const event = mkEvent();
        const hash = recordHash(seq, prev, event);
        await pool.query(
          `INSERT INTO audit_events (event_id, occurred_at, tenant, event_type, principal, event, chain_seq, prev_hash, record_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            event.event_id,
            event.occurred_at,
            tenant,
            event.event_type,
            'svc:test',
            JSON.stringify(event),
            seq,
            prev,
            hash,
          ],
        );
        rows.push({ id: event.event_id, seq, prev, hash, event });
        prev = hash;
      }

      // (a) UPDATE is refused by the append-only trigger.
      await expect(
        pool.query(`UPDATE audit_events SET event_type='model.invoked' WHERE event_id=$1`, [
          rows[1]!.id,
        ]),
      ).rejects.toThrow(/append-only/);

      // (b) A forged INSERT with bad linkage is refused by chain_check.
      await expect(
        pool.query(
          `INSERT INTO audit_events (event_id, occurred_at, tenant, event_type, principal, event, chain_seq, prev_hash, record_hash)
           VALUES ($1, now(), $2, 'tool.called', 'svc:x', '{}'::jsonb, 9, $3, $4)`,
          [randomUUID(), tenant, GENESIS_PREV_HASH, GENESIS_PREV_HASH],
        ),
      ).rejects.toThrow(/chain break|chain:/);

      // (c) Mutate a record with the append-only trigger dropped, then verify
      //     catches it as hash_mismatch at that seq (the record_hash column is
      //     unchanged, so the recompute over the mutated event diverges).
      await pool.query('DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events');
      await pool.query(
        `UPDATE audit_events SET event = jsonb_set(event, '{event_type}', '"killswitch.activated"') WHERE event_id=$1`,
        [rows[1]!.id],
      );
      await pool.query(`
        CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutation();
      `);

      const token = await ciToken('acp:audit', 'audit:read');
      const res = await fetch(`${AUDIT_URL}/v1/verify?tenant=${tenant}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        verified: boolean;
        failure?: { kind: string; chain_seq: number };
      };
      expect(body.verified).toBe(false);
      expect(body.failure?.kind).toBe('hash_mismatch');
      expect(body.failure?.chain_seq).toBe(2);
    } finally {
      // Clean up ONLY this throwaway tenant's rows (never a shared truncate).
      await pool.query('DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events');
      await pool.query(`DELETE FROM audit_events WHERE tenant=$1`, [tenant]);
      await pool.query(`
        CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutation();
      `);
      await pool.end();
    }
  }, 120_000);
});
