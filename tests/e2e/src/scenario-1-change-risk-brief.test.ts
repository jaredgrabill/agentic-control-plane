/**
 * DoD acceptance scenario 1 — Change-risk brief across four read domains plus a
 * governed draft. "Assess the risk of tonight's payments-api TLS upgrade and
 * open a draft change." runs as a five-step context.sequence:
 *   netsec.exposure_analysis · cloud.inventory_query · code.dependency_query ·
 *   knowledge.answer_with_citations · change.draft (R1)
 * The orchestrator composes ONE multi-section brief with per-step attribution
 * headers and concatenated citations from all four read domains, then drafts a
 * change record (R1 → no approval gate, completes headlessly). The audit trail
 * is the per-sub-question ledger: one dispatch/completion/brokered mint per leg.
 * Deterministic handlers, zero LLM in the read agents.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { McpToolClient } from '@acp/tool-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startPlatform, stopPlatform } from './support/platform.js';
import {
  ciToken,
  ensureRegisteredActive,
  pollAudit,
  submitSequence,
  waitForResult,
} from './support/scenario-helpers.js';

let platform: ChildProcess;

const ITSM_MOCK_URL = 'http://localhost:7303/mcp';
const itsmMock = new McpToolClient({ servers: { itsm: { url: ITSM_MOCK_URL } } });

const SEQUENCE = [
  'netsec.exposure_analysis',
  'cloud.inventory_query',
  'code.dependency_query',
  'knowledge.answer_with_citations',
  'change.draft',
];

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('scenario 1 — change-risk brief', () => {
  it('registers and activates the five agents the brief composes', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    for (const [dir, id] of [
      ['agents/netsec', 'netsec-agent'],
      ['agents/cloud', 'cloud-agent'],
      ['agents/code', 'code-agent'],
      ['python/agents/knowledge', 'knowledge-agent'],
      ['agents/change', 'change-agent'],
    ] as const) {
      await ensureRegisteredActive(
        join(repoRoot, ...dir.split('/'), 'manifest.yaml'),
        id,
        writeToken,
        'scenario 1 change-risk brief',
      );
    }
  });

  it('ingests the corpus so the knowledge leg can answer from policy', async () => {
    const token = await ciToken('acp:knowledge', 'knowledge:ingest');
    for (const sourceId of ['policy-docs', 'eng-standards']) {
      const res = await fetch(`http://localhost:7105/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ source_id: sourceId }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
  });

  let taskId: string;

  it('composes a five-section cited brief and opens a draft change', async () => {
    taskId = await submitSequence(SEQUENCE, [
      { service: 'payments-api' },
      { service: 'payments-api', env: 'prod' },
      { repo: 'acme/payments-service' },
      { question: 'What does our policy say about change freezes?' },
      {
        title: 'Upgrade payments-api TLS configuration',
        service: 'payments-api',
        window: { start: '2026-07-13T02:00:00Z', end: '2026-07-13T03:00:00Z' },
      },
    ]);

    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? result.gaps ?? {})).toBe('completed');

    // The plan is exactly the five sub-questions, in order.
    expect(result.plan?.steps.map((s) => s.capability)).toEqual(SEQUENCE);

    // One brief, facts drawn from all four read domains + the minted draft id.
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('0.0.0.0/0'); // netsec exposure
    expect(text).toContain('sg-payments-01'); // netsec security group
    expect(text).toContain('payments-api'); // cloud inventory / code deps
    expect(text).toContain('fiscal quarter'); // change-management freeze policy
    const draftId = /CHG-\d+/.exec(result.answer!.text)?.[0];
    expect(draftId, 'the brief must name the drafted change id').toBeDefined();

    // Per-step attribution headers: synthesis prefixes each section with
    // [capability — agent@version].
    for (const capability of SEQUENCE) {
      expect(text, `missing attribution header for ${capability}`).toContain(capability);
    }

    // Citations concatenate across all four read domains + the change log.
    const docIds = new Set(result.answer!.citations.map((c) => c.doc_id));
    for (const expected of [
      'netsec/security-groups',
      'netsec/ipam-allocations',
      'cloud/inventory-snapshot',
      'code/dependency-graph',
      'policy/change-management',
      'itsm/change-log',
    ]) {
      expect([...docIds], `missing citation ${expected}`).toContain(expected);
    }
    for (const citation of result.answer!.citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }

    // Confidence is the min over the steps (never over-confident on a chain).
    expect(result.answer!.confidence).toBeGreaterThan(0);
    expect(result.answer!.confidence).toBeLessThanOrEqual(0.9);

    // The draft is real in the itsm system of record — status draft.
    const record = await itsmMock.call('itsm', 'change_get', { change_id: draftId });
    expect((record.data.change as { status: string }).status).toBe('draft');
  }, 240_000);

  it('recorded a per-sub-question audit ledger: 5 dispatched, 5 completed, 5 brokered', async () => {
    const events = await pollAudit(
      taskId,
      (evs) => evs.filter((e) => e.event_type === 'step.completed').length >= 5,
    );
    const count = (type: string): number => events.filter((e) => e.event_type === type).length;
    expect(count('step.dispatched')).toBe(5);
    expect(count('step.completed')).toBe(5);
    expect(events.filter((e) => e.event_type === 'token.brokered').length).toBeGreaterThanOrEqual(
      5,
    );

    // Every leg's policy decision is an allow (four R0 reads + one R1 draft).
    const decisions = events.filter((e) => e.event_type === 'policy.decision');
    // Guard against a vacuous pass: the five legs must each have decided.
    expect(decisions.length).toBeGreaterThanOrEqual(5);
    for (const d of decisions) expect(d.reason?.policy?.decision).toBe('allow');

    // The five sub-questions were dispatched to the five distinct agents.
    const dispatched: AuditEvent[] = events.filter((e) => e.event_type === 'step.dispatched');
    const agents = new Set(dispatched.map((e) => e.artifacts?.agent_id));
    for (const id of [
      'netsec-agent',
      'cloud-agent',
      'code-agent',
      'knowledge-agent',
      'change-agent',
    ]) {
      expect([...agents], `missing dispatch to ${id}`).toContain(id);
    }

    // The task itself completed with a priced ledger entry.
    expect(events.some((e) => e.event_type === 'task.completed')).toBe(true);
  }, 120_000);
});
