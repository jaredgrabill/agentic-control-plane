/**
 * DoD acceptance scenario 2 — Cost-spike forensics as a governed multi-agent
 * chain. "Why did payments-api cost jump, and what change caused it?" fans the
 * question across three read domains as a context.sequence:
 *   cloud.cost_analysis · code.ci_health · change.record_lookup (NEW R0)
 * and composes one cited, multi-section brief that attributes the spend jump to
 * a service+deploy AND links that deploy back to its authorizing change record
 * (CHG-1006). The orchestrator-v1 NL slice covers the 2-agent cost/CI composite;
 * this drives the full 3-leg chain (the change-record link has no NL rule) and
 * asserts the per-sub-question audit ledger. Deterministic handlers, zero LLM.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startPlatform, stopPlatform } from './support/platform.js';
import {
  auditEvents,
  ciToken,
  ensureRegisteredActive,
  pollAudit,
  submitSequence,
  waitForResult,
} from './support/scenario-helpers.js';

let platform: ChildProcess;

const SEQUENCE = ['cloud.cost_analysis', 'code.ci_health', 'change.record_lookup'];

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('scenario 2 — cost-spike forensics chain', () => {
  it('registers and activates the cloud, code, and change agents', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    // ensureRegisteredActive (409-tolerant) not registerAndActivate: the change
    // agent's manifest changed on this branch, so a persistent local registry
    // carrying a stale card 409s on re-register. Matches the sibling scenarios.
    await ensureRegisteredActive(
      join(repoRoot, 'agents', 'cloud', 'manifest.yaml'),
      'cloud-agent',
      writeToken,
      'scenario 2 cost forensics',
    );
    await ensureRegisteredActive(
      join(repoRoot, 'agents', 'code', 'manifest.yaml'),
      'code-agent',
      writeToken,
      'scenario 2 cost forensics',
    );
    await ensureRegisteredActive(
      join(repoRoot, 'agents', 'change', 'manifest.yaml'),
      'change-agent',
      writeToken,
      'scenario 2 cost forensics',
    );
  });

  let taskId: string;

  it('composes the three-section cost→CI→change-record brief with concatenated citations', async () => {
    taskId = await submitSequence(SEQUENCE, [
      {},
      { repo: 'acme/payments-service' },
      { service: 'payments-api', deploy_id: 'd-2026-07-01-042' },
    ]);

    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? result.gaps ?? {})).toBe('completed');

    // The recorded plan IS the three sub-questions, in order.
    expect(result.plan?.steps.map((s) => s.capability)).toEqual(SEQUENCE);

    // One brief, three sections: spend attribution, CI correlation, and the
    // deploy→change-record link.
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('payments-api');
    expect(text).toContain('30.0'); // the spend jump, from cloud.cost_analysis
    expect(text).toContain('d-2026-07-01-042'); // the implicated deploy
    expect(text).toContain('pass rate'); // code.ci_health section
    expect(text).toContain('chg-1006'); // the linked change record (NEW cap)

    // Citations concatenate across all three domains, lineage intact.
    const docIds = result.answer!.citations.map((c) => c.doc_id);
    expect(docIds).toContain('cloud/cost-report');
    expect(docIds).toContain('code/ci-activity');
    expect(docIds).toContain('itsm/change-log'); // change.record_lookup provenance
    for (const citation of result.answer!.citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  }, 180_000);

  it('recorded a per-sub-question audit ledger: 3 dispatched, 3 completed, 3 brokered', async () => {
    const events = await pollAudit(
      taskId,
      (evs) => evs.filter((e) => e.event_type === 'step.completed').length >= 3,
    );
    const count = (type: string): number => events.filter((e) => e.event_type === type).length;
    expect(count('step.dispatched')).toBe(3);
    expect(count('step.completed')).toBe(3);

    // One brokered mint per step (each sub-question got its own delegated token).
    const brokered = events.filter((e) => e.event_type === 'token.brokered');
    expect(brokered.length).toBeGreaterThanOrEqual(3);

    // Each dispatch names its capability and rides the two-hop delegation chain.
    const dispatched = events.filter((e) => e.event_type === 'step.dispatched');
    const agents = dispatched.map((e) => e.artifacts?.agent_id).sort();
    expect(agents).toEqual(['change-agent', 'cloud-agent', 'code-agent']);
    for (const d of dispatched) {
      expect(d.actor.delegation_chain?.map((l) => l.sub)).toEqual([
        'user:jane.doe',
        'svc:orchestrator',
      ]);
    }

    // Every policy.decision on the chain is an allow (all three legs are R0).
    const decisions = events.filter((e) => e.event_type === 'policy.decision');
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    for (const d of decisions) expect(d.reason?.policy?.decision).toBe('allow');
  }, 120_000);

  it('recorded the change.record_lookup tool call through the gateway PEP', async () => {
    const toolEvents: AuditEvent[] = (await auditEvents(taskId, 'acme', 'tool.called')).filter(
      (e) => e.event_type === 'tool.called',
    );
    const lookup = toolEvents.find(
      (e) => (e.details as { tool?: string }).tool === 'change_record_lookup',
    );
    expect(lookup, 'a tool.called for change_record_lookup must exist').toBeDefined();
    expect((lookup!.details as { outcome: string }).outcome).toBe('ok');
    expect(lookup!.reason?.policy?.decision).toBe('allow');
    expect(lookup!.reason?.policy?.determining_policies).toContain(
      'allow-tool-itsm-change-record-lookup',
    );
    const chain = lookup!.actor.delegation_chain!.map((l) => l.sub);
    expect(chain[2]).toMatch(/^agent:change-agent@/);
  }, 120_000);
});
