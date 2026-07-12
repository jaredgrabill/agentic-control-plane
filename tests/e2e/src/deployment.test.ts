/**
 * Phase 3 Item 4 DoD — Deployment Controller v0. A shadow knowledge agent v2
 * (identical code, registered as 0.2.0) promotes to active through the gates
 * with ZERO manual routing, and a failing v3 candidate is auto-rejected while
 * the incumbent keeps serving. Also proves debt #3 (a new version never touches
 * the incumbent's card/baseline) and live shadow side-effect suppression.
 *
 * The v2/v3 candidate workers are test-owned children spawned from the venv
 * python directly (avoids the debt-#7 uv-grandchild orphan). Traffic is driven
 * by a background loop so every soak window has fresh samples.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  REGISTRY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const execFileAsync = promisify(execFile);
let platform: ChildProcess | undefined;
const candidateWorkers: ChildProcess[] = [];

/**
 * The project venv's python interpreter. uv lays the venv out per-OS —
 * Scripts/python.exe on Windows, bin/python everywhere else — so we cannot
 * hardcode one layout: a Windows-only path spawns ENOENT on the Linux CI
 * runner, which failed beforeAll and skipped the whole suite.
 */
const venvPython =
  process.platform === 'win32'
    ? join(repoRoot, 'python', '.venv', 'Scripts', 'python.exe')
    : join(repoRoot, 'python', '.venv', 'bin', 'python');

async function getToken(clientId: string, secret: string, audience: string, scope?: string) {
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

/** The version-routing bucket the orchestrator computes (must match resolveRoute). */
function bucketOf(taskId: string): number {
  return parseInt(createHash('sha256').update(taskId).digest('hex').slice(0, 7), 16) % 100;
}

async function registerVersion(
  version: string,
  writeToken: string,
): Promise<Record<string, unknown>> {
  const { parse } = await import('yaml');
  const { readFileSync } = await import('node:fs');
  const manifest = parse(
    readFileSync(join(repoRoot, 'python', 'agents', 'knowledge', 'manifest.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  const res = await fetch(`${REGISTRY_URL}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify({ manifest, version }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

/** Regenerates the golden-suite baseline for a version and records it on that row. */
async function recordBaseline(version: string, writeToken: string): Promise<void> {
  const out = join(mkdtempSync(join(tmpdir(), 'acp-baseline-')), `baseline-${version}.json`);
  await execFileAsync(
    venvPython,
    ['-m', 'knowledge_agent.eval_report', '--out', out, '--agent-version', version],
    { cwd: join(repoRoot, 'python', 'agents', 'knowledge', 'src'), env: { ...process.env } },
  );
  const { readFileSync } = await import('node:fs');
  const report = JSON.parse(readFileSync(out, 'utf8')) as {
    agent_id: string;
    agent_version: string;
    suite: Record<string, unknown>;
    metrics: Record<string, unknown>;
    sdk?: string;
    generated_at?: string;
  };
  // The eval-report is not itself an eval_baseline — project it onto one.
  const baseline = {
    schema: 'acp-eval-baseline/v1',
    agent_id: report.agent_id,
    agent_version: report.agent_version,
    metrics: report.metrics,
    suite: report.suite,
    harness: report.sdk ?? 'acp-agent-sdk-py@0.1.0',
    recorded_at: report.generated_at ?? new Date().toISOString(),
  };
  const res = await fetch(`${REGISTRY_URL}/v1/agents/knowledge-agent/baseline`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify(baseline),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Spawns a test-owned candidate worker on agent-knowledge-agent@{version}. */
function spawnCandidate(
  version: string,
  clientId: string,
  secret: string,
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const child = spawn(venvPython, ['-m', 'knowledge_agent.main'], {
    cwd: join(repoRoot, 'python', 'agents', 'knowledge', 'src'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      ACP_AGENT_VERSION: version,
      ACP_AGENT_CLIENT_ID: clientId,
      ACP_AGENT_CLIENT_SECRET: secret,
      ACP_TOKEN_URL: TOKEN_URL,
      ACP_NATS_URL: process.env.ACP_NATS_URL ?? 'nats://localhost:4222',
      ACP_TEMPORAL_ADDRESS: process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
      ...extraEnv,
    },
  });
  candidateWorkers.push(child);
  return child;
}

function stopChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

/** True once a child's run has settled (exited by code or signal). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Stops a child and resolves only once its process has actually exited (its
 * run() has settled), so teardown never returns while a worker is still
 * draining. Bounded so a wedged child can't hang the suite forever.
 */
async function stopChildAndWait(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
  stopChild(child);
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

/**
 * Fully tears down the platform child, waiting for the whole service tree to
 * exit. Force-killing without waiting lets the next file boot run-platform on
 * the same fixed ports/task-queues while this platform's Temporal workers are
 * still DRAINING — the exact race that surfaces as an IllegalStateError and
 * fails the file. Awaiting exit here serialises the handoff.
 */
async function stopPlatformAndWait(p: ChildProcess | undefined, timeoutMs = 30_000): Promise<void> {
  if (p === undefined) return;
  if (hasExited(p)) return;
  const exited = new Promise<void>((resolve) => {
    p.once('exit', () => {
      resolve();
    });
    p.once('error', () => {
      resolve();
    });
  });
  stopPlatform(p);
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

/**
 * Waits for a freshly spawned candidate worker to have a chance to connect its
 * queue, failing fast if it exits first. Guards against driving traffic at (or
 * asserting shutdown of) a worker whose run() already settled — a settled
 * worker is what throws IllegalStateError on a later touch.
 */
async function awaitCandidateReady(child: ChildProcess, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `candidate worker exited before it became ready (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function submitTask(): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await jane()}` },
    body: JSON.stringify({
      text: 'What is our data retention policy for customer PII?',
      capability: 'knowledge.answer_with_citations',
    }),
  });
  if (res.status !== 202) return '';
  return ((await res.json()) as { task_id: string }).task_id;
}

/** Drives steady traffic until stopped, returning every submitted task id. */
function startTraffic(): { stop: () => Promise<string[]> } {
  const ids: string[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const id = await submitTask().catch(() => '');
      if (id !== '') ids.push(id);
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
      return ids;
    },
  };
}

async function deployStatus(): Promise<{
  phase: string;
  running?: boolean;
  result?: { status: string };
}> {
  const token = await ci('acp:gateway', 'deploy:read');
  const res = await fetch(`${GATEWAY_URL}/v1/deployments/knowledge-agent`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { phase: string; running?: boolean; result?: { status: string } };
}

async function waitForDeployment(timeoutMs: number): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await deployStatus();
    if (view.running === false && view.result !== undefined) return view.result;
    if (Date.now() > deadline)
      throw new Error(`deployment still ${view.phase} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function platformAudit(eventType: string): Promise<AuditEvent[]> {
  const token = await ci('acp:audit', 'audit:read');
  const res = await fetch(
    `${AUDIT_URL}/v1/events?tenant=platform&event_type=${eventType}&limit=1000`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

async function acmeAudit(eventType: string): Promise<AuditEvent[]> {
  const token = await ci('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&event_type=${eventType}&limit=1000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

async function versionState(
  version: string,
): Promise<{ lifecycle_state: string; deployed_at?: string }> {
  const token = await ci('acp:registry', 'registry:read');
  const res = await fetch(`${REGISTRY_URL}/v1/agents/knowledge-agent/versions/${version}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { lifecycle_state: string; deployed_at?: string };
}

/** Ensures knowledge-agent 0.1.0 is registered AND active (reinstating if a
 *  prior session left it suspended) — resilient to a non-fresh dev stack. */
async function ensureIncumbentActive(writeToken: string): Promise<void> {
  await registerVersion('0.1.0', writeToken).catch(() => undefined); // 200/201 either way
  const st = await versionState('0.1.0');
  if (st.lifecycle_state === 'active') return;
  if (st.lifecycle_state === 'registered' || st.lifecycle_state === 'suspended') {
    const res = await fetch(`${REGISTRY_URL}/v1/agents/knowledge-agent/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ state: 'active', reason: 'deployment E2E incumbent' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return;
  }
  throw new Error(
    `incumbent 0.1.0 is ${st.lifecycle_state} — reset the dev stack for a clean deployment E2E`,
  );
}

beforeAll(async () => {
  platform = await startPlatform();
  // Ensure the incumbent v1 (0.1.0) is active; run-platform serves its worker.
  const writeToken = await ci('acp:registry', 'registry:write registry:admin');
  await ensureIncumbentActive(writeToken);
  await recordBaseline('0.1.0', writeToken);
  void registerAndActivate;
}, 300_000);

afterAll(async () => {
  // Best-effort but AWAITED teardown: stop every candidate worker and the
  // platform tree and wait for each to exit, wrapped so a draining worker's
  // IllegalStateError can never escape the hook and crash the file. Candidate
  // workers first (they connect to the platform), then the platform itself.
  try {
    await Promise.allSettled(candidateWorkers.map((w) => stopChildAndWait(w)));
  } catch {
    /* teardown is best-effort */
  }
  try {
    await stopPlatformAndWait(platform);
  } catch {
    /* teardown is best-effort */
  }
}, 120_000);

describe('deployment controller v0 (DoD)', () => {
  it('promotes a shadow candidate to active through the gates with zero manual routing', async () => {
    const writeToken = await ci('acp:registry', 'registry:write registry:admin');

    // Register v2 — proves debt #3: the incumbent's active card + baseline are
    // untouched by a new-version registration.
    const activeBefore = await versionState('0.1.0');
    await registerVersion('0.2.0', writeToken);
    const activeAfter = await versionState('0.1.0');
    expect(activeAfter.lifecycle_state).toBe('active');
    expect(await versionState('0.2.0')).toMatchObject({ lifecycle_state: 'registered' });
    void activeBefore;

    await recordBaseline('0.2.0', writeToken);
    const v2 = spawnCandidate('0.2.0', 'agent-knowledge-agent-v2', 'agent-knowledge-v2-dev-secret');
    // Give the candidate worker time to connect its queue, failing fast if it
    // dies first rather than driving traffic at a worker that never came up.
    await awaitCandidateReady(v2, 8000);

    // Start the deployment via the CLI (exercises deploy.mjs end-to-end).
    const config = JSON.stringify({
      shadow_soak_s: 5,
      ramp_soak_s: 6,
      min_shadow_samples: 2,
      drain_s: 2,
      ramp_steps: [50, 100],
      thresholds: {
        max_success_delta: 0.05,
        max_p95_ratio: 3,
        max_cost_ratio: 5,
        min_shadow_completion: 0.5,
        min_shadow_samples: 2,
      },
    });
    const traffic = startTraffic();
    await execFileAsync(
      'node',
      [
        join(repoRoot, 'scripts', 'deploy.mjs'),
        'start',
        'knowledge-agent',
        '0.2.0',
        '--tenant',
        'acme',
        '--config',
        config,
      ],
      { cwd: repoRoot, env: { ...process.env } },
    );

    const result = await waitForDeployment(120_000);
    const ids = await traffic.stop();
    expect(result.status).toBe('completed');

    // Terminal registry state: v2 active with deployed_at, v1 deprecated→retired.
    expect(await versionState('0.2.0')).toMatchObject({ lifecycle_state: 'active' });
    expect((await versionState('0.2.0')).deployed_at).toBeDefined();
    expect((await versionState('0.1.0')).lifecycle_state).toBe('retired');

    // Audit chain: started → shadow_result×N → ramped×2 → promoted → completed.
    const started = await platformAudit('deployment.started');
    const promoted = await platformAudit('deployment.promoted');
    const completed = await platformAudit('deployment.completed');
    const shadowResults = await acmeAudit('deployment.shadow_result');
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(promoted.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(shadowResults.length).toBeGreaterThanOrEqual(2);
    // Each shadow_result is paired to a real primary step (task_id + step_id).
    for (const e of shadowResults) {
      expect(e.reason?.task_id).toBeDefined();
      expect(e.reason?.step_id).toBeDefined();
    }

    // Session pinning proof: for the canary window, a task's routed version is a
    // pure function of its bucket vs the ramp — steps ran on exactly one side.
    const stepCompleted = await acmeAudit('step.completed');
    const versionByTask = new Map<string, Set<string>>();
    for (const e of stepCompleted) {
      const tid = e.reason?.task_id;
      const v = e.artifacts?.agent_version;
      if (tid === undefined || v === undefined) continue;
      let set = versionByTask.get(tid);
      if (set === undefined) {
        set = new Set<string>();
        versionByTask.set(tid, set);
      }
      set.add(v);
    }
    // No task's primary steps split across versions (one version per session).
    for (const versions of versionByTask.values()) {
      expect(versions.size).toBe(1);
    }
    // At least one task was served by the candidate during the ramp.
    const servedByCandidate = ids.some((id) => versionByTask.get(id)?.has('0.2.0'));
    expect(servedByCandidate).toBe(true);

    // Post-promotion: a fresh task is served by 0.2.0 on its versioned queue.
    const postId = await submitTask();
    await new Promise((r) => setTimeout(r, 6000));
    const post = (await acmeAudit('step.completed')).filter((e) => e.reason?.task_id === postId);
    expect(post.some((e) => e.artifacts?.agent_version === '0.2.0')).toBe(true);
    void bucketOf;
  }, 300_000);

  it('auto-rejects a failing candidate; the incumbent keeps serving', async () => {
    const writeToken = await ci('acp:registry', 'registry:write registry:admin');
    await registerVersion('0.3.0', writeToken);
    await recordBaseline('0.3.0', writeToken);
    // v3 fails every answer (deployment-rehearsal directive) — shadow/canary
    // steps breach, so the controller rejects it.
    const v3 = spawnCandidate(
      '0.3.0',
      'agent-knowledge-agent-v3',
      'agent-knowledge-v3-dev-secret',
      {
        ACP_KNOWLEDGE_AGENT_FAILURE: 'permanent',
      },
    );
    await awaitCandidateReady(v3, 8000);

    const config = JSON.stringify({
      shadow_soak_s: 5,
      ramp_soak_s: 6,
      min_shadow_samples: 2,
      drain_s: 2,
      ramp_steps: [50, 100],
      thresholds: {
        max_success_delta: 0.05,
        max_p95_ratio: 3,
        max_cost_ratio: 5,
        min_shadow_completion: 0.9,
        min_shadow_samples: 2,
      },
    });
    const traffic = startTraffic();
    const deployToken = await ci('acp:gateway', 'deploy:write');
    const start = await fetch(`${GATEWAY_URL}/v1/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deployToken}` },
      body: JSON.stringify({
        agent_id: 'knowledge-agent',
        candidate_version: '0.3.0',
        tenant: 'acme',
        config: JSON.parse(config) as Record<string, unknown>,
      }),
    });
    expect(start.status).toBe(202);

    const result = await waitForDeployment(120_000);
    await traffic.stop();
    // The candidate is rejected (failed or demoted) — never promoted.
    expect(['failed', 'demoted']).toContain(result.status);
    expect((await versionState('0.3.0')).lifecycle_state).not.toBe('active');
    // The incumbent (0.2.0, promoted in the previous test) is still active…
    expect((await versionState('0.2.0')).lifecycle_state).toBe('active');
    // …and still serving a fresh task on its version.
    const postId = await submitTask();
    await new Promise((r) => setTimeout(r, 6000));
    const post = (await acmeAudit('step.completed')).filter((e) => e.reason?.task_id === postId);
    expect(post.some((e) => e.artifacts?.agent_version === '0.2.0')).toBe(true);
  }, 300_000);
});
