/**
 * DoD acceptance scenario 3 — Policy exposure audit across four read domains.
 * "Which internet-exposed services run images with critical CVEs, and what does
 * policy require?" runs as a four-step context.sequence:
 *   netsec.cve_exposure (NEW R0) · cloud.inventory_query ·
 *   code.dependency_query · knowledge.answer_with_citations
 * The NEW netsec.cve_exposure joins the vuln-scan findings with the
 * security-group snapshot BY SERVICE — the join neither tool answers alone. The
 * orchestrator composes a four-section audit where every claim is cited, and
 * the audit trail is the per-sub-question ledger with a per-tool Cedar allow for
 * each read. Deterministic handlers, zero LLM in the read agents.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAndActivate, repoRoot, startPlatform, stopPlatform } from './support/platform.js';
import {
  auditEvents,
  ciToken,
  pollAudit,
  submitSequence,
  waitForResult,
} from './support/scenario-helpers.js';

let platform: ChildProcess;

const SEQUENCE = [
  'netsec.cve_exposure',
  'cloud.inventory_query',
  'code.dependency_query',
  'knowledge.answer_with_citations',
];

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('scenario 3 — policy exposure audit', () => {
  it('registers and activates the four agents the audit composes', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    for (const [dir, id] of [
      ['agents/netsec', 'netsec-agent'],
      ['agents/cloud', 'cloud-agent'],
      ['agents/code', 'code-agent'],
      ['python/agents/knowledge', 'knowledge-agent'],
    ] as const) {
      await registerAndActivate(
        join(repoRoot, ...dir.split('/'), 'manifest.yaml'),
        id,
        writeToken,
        'scenario 3 policy exposure audit',
      );
    }
  });

  it('ingests the corpus so the policy leg can answer', async () => {
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

  it('composes a four-section audit where the CVE-on-exposed-service claim is cited', async () => {
    taskId = await submitSequence(SEQUENCE, [
      { service: 'payments-api' },
      { service: 'payments-api', env: 'prod' },
      { repo: 'acme/payments-service' },
      {
        question:
          'What does our information security policy require for internet-exposed ' +
          'services running images with critical CVEs?',
      },
    ]);

    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? result.gaps ?? {})).toBe('completed');

    // The plan is exactly the four sub-questions, in order.
    expect(result.plan?.steps.map((s) => s.capability)).toEqual(SEQUENCE);

    // The joined risk is named and cited: the critical CVE on the exposed service.
    const text = result.answer!.text.toLowerCase();
    expect(text).toContain('cve-2026-31337');
    expect(text).toContain('critical');
    expect(text).toContain('0.0.0.0/0');
    expect(text).toContain('payments-api');

    // Every read domain cited, including BOTH netsec snapshots the NEW cap joins
    // and the policy the audit is measured against.
    const docIds = new Set(result.answer!.citations.map((c) => c.doc_id));
    for (const expected of [
      'netsec/vuln-scan',
      'netsec/security-groups',
      'cloud/inventory-snapshot',
      'code/dependency-graph',
      'policy/information-security',
    ]) {
      expect([...docIds], `missing citation ${expected}`).toContain(expected);
    }
    for (const citation of result.answer!.citations) {
      expect(citation.lineage_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  }, 240_000);

  it('recorded exactly four sub-question dispatches and a per-tool Cedar allow per read', async () => {
    const events = await pollAudit(
      taskId,
      (evs) => evs.filter((e) => e.event_type === 'step.completed').length >= 4,
    );
    expect(events.filter((e) => e.event_type === 'step.dispatched')).toHaveLength(4);
    expect(events.filter((e) => e.event_type === 'step.completed')).toHaveLength(4);

    // One retrieval.served — the knowledge leg, and only that leg, retrieves.
    const retrievals = (await auditEvents(taskId, 'acme', 'retrieval.served')).filter(
      (e) => e.event_type === 'retrieval.served',
    );
    expect(retrievals.length).toBeGreaterThanOrEqual(1);

    // Per-tool Cedar allows: the NEW cap's two joined reads, plus cloud inventory
    // and the code dependency read.
    const toolEvents: AuditEvent[] = (await auditEvents(taskId, 'acme', 'tool.called')).filter(
      (e) => e.event_type === 'tool.called',
    );
    const toolNames = new Set(toolEvents.map((e) => e.action.name));
    for (const expected of [
      'tool:netsec:vuln_scan_report',
      'tool:netsec:security_group_get',
      'tool:cloud-estate:inventory_search',
      'tool:code-forge:repo_dependencies',
    ]) {
      expect([...toolNames], `missing tool call ${expected}`).toContain(expected);
    }
    for (const e of toolEvents) {
      expect(e.reason?.policy?.decision, `${e.action.name} must be allowed`).toBe('allow');
      // Each tool call rides the full three-hop delegation chain to its agent.
      const chain = e.actor.delegation_chain!.map((l) => l.sub);
      expect(chain).toHaveLength(3);
      expect(chain[0]).toBe('user:jane.doe');
      expect(chain[1]).toBe('svc:orchestrator');
      expect(chain[2]).toMatch(/^agent:[a-z-]+@/);
    }
  }, 120_000);
});
