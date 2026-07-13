/**
 * DoD onboarding acceptance proof — an external team onboards an agent all the
 * way to ACTIVE with zero platform changes, and the active external agent
 * answers a governed task. Two claims, end to end against the real stack:
 *
 *   1. Scaffold → active, zero platform-file diff. The paved-road SLO harness
 *      (scripts/paved-road-slo.mjs) scaffolds a throwaway agent OUTSIDE the
 *      repo, provisions its bus client, registers it, records a baseline, and
 *      promotes it to active via the registered→active admin edge — all
 *      API-driven — then re-asserts the git working tree gained NO platform diff
 *      (apps/**, packages/**, deploy/**, .github/**, policies/**,
 *      run-platform.mjs). agent-lifecycle.md has no shadow→active edge, so the
 *      onboarding-to-active proof takes the documented admin promotion.
 *   2. An active external agent answers a task. A fixture probe agent is
 *      promoted to active (registered→active admin edge) and served by an
 *      in-process worker; a governed task routed to its R0 probe.echo capability
 *      completes with a cited answer through the full control path.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, agentTaskQueue } from '@acp/agent-sdk';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { TaskResult } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GATEWAY_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';
import { ciToken, janeToken, waitForResult } from './support/scenario-helpers.js';

const PROBE_AGENT_ID = 'paved-road-probe-agent';
const PROBE_VERSION = '0.1.0';
const PROBE_MANIFEST = join(
  repoRoot,
  'tests',
  'e2e',
  'fixtures',
  'paved-road-probe-agent.manifest.yaml',
);

let platform: ChildProcess;
let probeWorker: { shutdown: () => Promise<void> } | undefined;

/** In-process worker for the fixture probe agent — canned, side-effect-free. */
async function startProbeAgent(): Promise<{ shutdown: () => Promise<void> }> {
  const agent = Agent.fromManifest(PROBE_MANIFEST);
  agent.capability('probe.echo', (_ctx: unknown, input: Record<string, unknown>) => {
    const note = typeof input.note === 'string' ? input.note : 'onboarded';
    return Promise.resolve({
      text: `probe.echo online — external agent ${PROBE_AGENT_ID} answered (${note}) [1]`,
      citations: [
        {
          doc_id: 'external/probe-manifest',
          version: '1',
          lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3fbb',
        },
      ],
      confidence: 0.95,
    });
  });

  const connection = await NativeConnection.connect({
    address: process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.ACP_TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: agentTaskQueue(agent.agentId, PROBE_VERSION),
    activities: { execute_capability: (request: unknown) => agent.execute(request) },
  });
  const running = worker.run();
  return {
    async shutdown() {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}

async function submitCapability(
  capability: string,
  context: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text: `onboarding probe ${capability}`, capability, context }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
  return ((await res.json()) as { task_id: string }).task_id;
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(async () => {
  await probeWorker?.shutdown();
  stopPlatform(platform);
});

describe('onboarding — external team scaffolds an agent to active with zero platform changes', () => {
  it('drives an API-only scaffold all the way to active with no platform-file diff', async () => {
    const scriptUrl = pathToFileURL(join(repoRoot, 'scripts', 'paved-road-slo.mjs')).href;
    const { runPavedRoadSlo } = (await import(scriptUrl)) as {
      runPavedRoadSlo: (o: Record<string, unknown>) => Promise<{
        ok: boolean;
        reachedActive: boolean;
        lifecycleState: string;
        elapsedMs: number;
        sloMs: number;
      }>;
    };
    // The harness throws on any zero-change-invariant violation or SLO miss.
    const result = await runPavedRoadSlo({ repoRoot, sloMs: 60_000, driveToActive: true });
    expect(result.ok).toBe(true);
    expect(result.reachedActive).toBe(true);
    expect(result.lifecycleState).toBe('active');
    expect(result.elapsedMs).toBeLessThan(result.sloMs);
  }, 120_000);

  it('serves a governed task from an active external agent through the full control path', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    // registerAndActivate uses the legacy /state route with state:active — the
    // registered→active admin edge, zero platform files touched.
    await registerAndActivate(
      PROBE_MANIFEST,
      PROBE_AGENT_ID,
      writeToken,
      'DoD onboarding: external agent to active',
    );
    probeWorker = await startProbeAgent();

    const taskId = await submitCapability('probe.echo', { note: 'dod-proof' });
    const result: TaskResult = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
    expect(result.answer!.text).toContain('probe.echo online');
    expect(result.answer!.citations.length).toBeGreaterThan(0);
    // The task was served by the newly-onboarded external agent.
    expect(result.plan?.steps.map((s) => s.capability)).toEqual(['probe.echo']);
  }, 180_000);
});
