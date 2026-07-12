/**
 * Phase 3 Item 6 — Online Evaluation v0, end to end against the live stack.
 *
 * 1. The synthetic prober runs a known-answer probe through a REAL TaskWorkflow
 *    against the live knowledge agent → eval.probe_result passed:true; the
 *    quality endpoint shows the probe SLI and state ok.
 * 2. A sampled production step is judged out-of-band → eval.score is emitted
 *    with a recorded outcome and the judge's model.invoked. (The exact-0.92
 *    directive path needs an inline directive doc; the knowledge ingest API is
 *    source_id-only, so this asserts the DOCUMENTED FALLBACK — the sampled-judge
 *    pipeline runs end to end and records an eval.score. The exact-score fold is
 *    unit-proven in the orchestrator's scoreWithJudge tests.)
 * 3. Degradation → change freeze → auto-suspend, hermetically: a dedicated
 *    poison-agent is driven to the SLO floor by failing score ingests. The
 *    budget freezes (a deployment is refused with reason change_freeze, the
 *    freeze preceding candidate validation), then the floor auto-suspends the
 *    agent (killswitch.activated) and pages. Teardown reinstates it; the budget
 *    self-recovers as its window slides.
 *
 * Run individually (the full suite OOMs this dev box):
 *   pnpm --filter @acp/e2e exec vitest run src/online-eval.test.ts
 */

import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  EVALUATION_URL,
  GATEWAY_URL,
  KNOWLEDGE_URL,
  REGISTRY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

let platform: ChildProcess | undefined;

async function getToken(
  clientId: string,
  secret: string,
  audience: string,
  scope?: string,
): Promise<string> {
  const res = await fetch(`${TOKEN_URL}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      audience,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}
const ci = (audience: string, scope: string) =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);
const jane = () => getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');

async function auditEvents(opts: { tenant?: string; taskId?: string } = {}): Promise<AuditEvent[]> {
  const tenant = opts.tenant ?? 'acme';
  const token = await ci('acp:audit', 'audit:read');
  const url =
    `${AUDIT_URL}/v1/events?tenant=${tenant}&limit=1000` +
    (opts.taskId === undefined ? '' : `&task_id=${opts.taskId}`);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

/** Polls until predicate finds a matching event, or throws. */
async function waitForAudit(
  predicate: (e: AuditEvent) => boolean,
  opts: { tenant?: string; taskId?: string; timeoutMs?: number; what?: string } = {},
): Promise<AuditEvent> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const match = (await auditEvents(opts)).find(predicate);
    if (match !== undefined) return match;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${opts.what ?? 'audit event'}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function submitTask(text: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await jane()}` },
    body: JSON.stringify({ text }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

async function waitForResult(taskId: string, timeoutMs = 90_000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await jane()}` },
    });
    const body = (await res.json()) as { status: string };
    if (body.status === 'completed' || body.status === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`task ${taskId} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** POSTs a score ingest to the eval service (svc-ci holds eval:write). */
async function postScore(body: Record<string, unknown>): Promise<void> {
  const token = await ci('acp:eval', 'eval:write');
  const res = await fetch(`${EVALUATION_URL}/v1/scores`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(202);
}

async function quality(agentId: string): Promise<{
  budget: { state: string; burn_ratio: number };
  frozen: boolean;
  level: string;
  sli: { n_by_source: { probe: number; judge: number } };
}> {
  const token = await ci('acp:eval', 'eval:read');
  const res = await fetch(`${EVALUATION_URL}/v1/agents/${agentId}/quality`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as never;
}

/** Runs scripts/probes.mjs with a chosen online-eval config (start|stop). */
function runProbes(action: 'start' | 'stop', configPath: string): void {
  execFileSync('node', [join(repoRoot, 'scripts', 'probes.mjs'), action], {
    cwd: repoRoot,
    env: { ...process.env, ACP_ONLINE_EVAL: configPath },
    stdio: 'inherit',
  });
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('online evaluation v0', () => {
  it('sets up the knowledge agent (register, activate, ingest, baseline)', async () => {
    const writeToken = await ci('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'python', 'agents', 'knowledge', 'manifest.yaml'),
      'knowledge-agent',
      writeToken,
      'online-eval e2e setup',
    );
    const ingestToken = await ci('acp:knowledge', 'knowledge:ingest');
    for (const sourceId of ['policy-docs', 'eng-standards', 'runbooks']) {
      const res = await fetch(`${KNOWLEDGE_URL}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ingestToken}` },
        body: JSON.stringify({ source_id: sourceId }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    execFileSync(
      'node',
      [
        join(repoRoot, 'apps', 'evaluation', 'dist', 'main.js'),
        'record',
        '--baseline',
        join(repoRoot, 'python', 'agents', 'knowledge', 'evals', 'baseline.json'),
        '--registry',
        REGISTRY_URL,
        '--token-url',
        TOKEN_URL,
        '--client-id',
        'svc-ci',
        '--client-secret',
        'ci-dev-secret',
      ],
      { cwd: repoRoot },
    );
  }, 120_000);

  it('probes the live knowledge agent → eval.probe_result passed:true, quality SLI ok', async () => {
    // The prober auto-started at boot (before the agent was ready); restart it
    // now with a short interval so a fresh cycle runs against the ready agent.
    const cfgPath = join(mkdtempSync(join(tmpdir(), 'acp-probe-')), 'online-eval.json');
    const cfg = JSON.parse(
      readFileSync(join(repoRoot, 'deploy', 'dev', 'online-eval.json'), 'utf8'),
    ) as { probes: { interval_s: number } };
    cfg.probes.interval_s = 10;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    runProbes('stop', cfgPath);
    runProbes('start', cfgPath);

    const probe = await waitForAudit(
      (e) =>
        e.event_type === 'eval.probe_result' &&
        e.artifacts?.agent_id === 'knowledge-agent' &&
        (e.details as { passed?: boolean }).passed === true,
      { tenant: 'acme', what: 'a passing knowledge probe', timeoutMs: 90_000 },
    );
    expect((probe.details as { case?: string }).case).toBe('change-freeze-policy');

    const q = await quality('knowledge-agent');
    expect(q.sli.n_by_source.probe).toBeGreaterThan(0);
    expect(q.budget.state).toBe('ok');
    expect(q.frozen).toBe(false);
  }, 120_000);

  it('judges a sampled production step → eval.score with a recorded outcome (fallback)', async () => {
    const taskId = await submitTask('What does our policy say about change freezes?');
    const result = await waitForResult(taskId);
    expect(result.status).toBe('completed');

    // per_agent knowledge=100 → the step is judged out-of-band. A normal
    // (directive-free) answer yields outcome unparseable_verdict; the eval.score
    // audit with its recorded outcome + model_class is the fallback assertion.
    const score = await waitForAudit(
      (e) => e.event_type === 'eval.score' && e.reason?.task_id === taskId,
      { tenant: 'acme', taskId, what: 'an eval.score for the judged step', timeoutMs: 90_000 },
    );
    expect(score.action.name).toBe('judge:answer-quality@1');
    const details = score.details as { outcome?: string; model_class?: string; route?: string };
    expect(details.outcome).toBeTruthy();
    expect(details.model_class).toBe('default-tier');
    expect(details.route).toBe('active');

    // The judge's own LLM usage is a model.invoked with purpose 'judge', stamped
    // with the CALLER's tenant (svc:orchestrator → platform), not the task
    // tenant — judge cost is a platform cost center, not the tenant's.
    const judgeInvoked = (await auditEvents({ tenant: 'platform' })).some(
      (e) =>
        e.event_type === 'model.invoked' && (e.details as { purpose?: string }).purpose === 'judge',
    );
    expect(judgeInvoked).toBe(true);
  }, 120_000);

  it('drives a poison agent to the SLO floor: freeze refuses a deployment, floor suspends', async () => {
    // A dedicated single-version agent so the registry:suspend edge (whole-id)
    // is unambiguous, and so this never perturbs the knowledge routing.
    const writeToken = await ci('acp:registry', 'registry:write registry:admin');
    const manifest = {
      id: 'poison-agent',
      name: 'Poison Agent (online-eval test)',
      owner: 'team-eval',
      description: 'A test-only agent used to drive the online-eval degradation ladder.',
      capabilities: [
        {
          name: 'eval.canary_probe',
          description: 'A no-op capability used only for ladder testing.',
          risk: 'R0',
          input_schema: { type: 'object' },
          output_schema: { type: 'object' },
          examples: [{ input: {} }, { input: {} }, { input: {} }],
        },
      ],
    };
    const reg = await fetch(`${REGISTRY_URL}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ manifest, version: '0.1.0' }),
    });
    expect([200, 201], await reg.clone().text()).toContain(reg.status);
    const activate = await fetch(`${REGISTRY_URL}/v1/agents/poison-agent/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ state: 'active', reason: 'online-eval ladder test' }),
    });
    expect([200, 409], await activate.clone().text()).toContain(activate.status);

    const failScore = (): Record<string, unknown> => ({
      id: randomUUID(),
      agent_id: 'poison-agent',
      agent_version: '0.1.0',
      capability: 'eval.canary_probe',
      tenant: 'platform',
      source: 'probe',
      route: 'probe',
      score: null,
      passed: false,
      weight: 5,
    });

    // Four failing PROBES trip the FLOOR via consecutive full-cycle probe
    // failures (floor_probe_cycles=4) — the trusted golden-probe signal. Note the
    // floor deliberately requires this probe corroboration: judge-burn alone
    // (attacker-chosen inputs) can only reach the reversible severe rung, never
    // this irreversible auto-suspend (the cross-tenant DoS guard; asserted in the
    // unit/service tests). The climb crosses severe first (deployment-abort) then
    // reaches floor; the budget is frozen throughout AND the floor pages.
    await postScore(failScore());
    await postScore(failScore());
    await postScore(failScore());
    await postScore(failScore());
    const floor = await waitForAudit(
      (e) =>
        e.event_type === 'eval.budget_state_changed' &&
        e.artifacts?.agent_id === 'poison-agent' &&
        (e.details as { to?: string }).to === 'floor',
      { tenant: 'platform', what: 'the SLO-floor transition', timeoutMs: 30_000 },
    );
    expect((floor.details as { page?: boolean }).page).toBe(true);

    const frozen = await quality('poison-agent');
    expect(frozen.frozen).toBe(true);

    // A deployment is refused by the fail-closed change freeze — the freeze
    // precedes candidate validation, so no 0.2.0 candidate need exist.
    const deploy = await fetch(`${GATEWAY_URL}/v1/deployments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await ci('acp:gateway', 'deploy:write')}`,
      },
      body: JSON.stringify({ agent_id: 'poison-agent', candidate_version: '0.2.0' }),
    });
    expect(deploy.status).toBe(202);
    await waitForAudit(
      (e) =>
        e.event_type === 'deployment.failed' &&
        e.artifacts?.agent_id === 'poison-agent' &&
        (e.details as { reason?: string }).reason === 'change_freeze',
      { tenant: 'platform', what: 'the change-freeze deployment refusal', timeoutMs: 60_000 },
    );

    // The floor auto-suspended the agent = kill switch tier 1.
    await waitForAudit(
      (e) =>
        e.event_type === 'killswitch.activated' &&
        (e.details as { agent_id?: string; tier?: string }).agent_id === 'poison-agent',
      { tenant: 'platform', what: 'the auto-suspend kill switch', timeoutMs: 30_000 },
    );
    const readToken = await ci('acp:registry', 'registry:read');
    const card = await fetch(`${REGISTRY_URL}/v1/agents/poison-agent`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(((await card.json()) as { lifecycle_state: string }).lifecycle_state).toBe('suspended');

    // Teardown: reinstate (admin) so a shared CI volume is left clean. The
    // budget self-recovers as its 24h window slides past the failing rows.
    const reinstate = await fetch(`${REGISTRY_URL}/v1/agents/poison-agent/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ state: 'active', reason: 'online-eval teardown' }),
    });
    expect([200, 409], await reinstate.clone().text()).toContain(reinstate.status);
  }, 180_000);
});
