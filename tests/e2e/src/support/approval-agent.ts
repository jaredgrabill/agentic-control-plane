/**
 * In-process TS agent for the governed-approval E2E slice. The
 * approval-test-agent isn't part of the deployed platform, so this test owns
 * its worker: it registers execute_capability on the agent's task queue and
 * answers with a canned Answer envelope (no real side effect — this slice
 * exercises the approval machinery, not a tool write). No NATS/bus identity is
 * needed: we run a bare Temporal worker directly and the agent falls back to
 * FakeModel (the canned handler never calls a model or retriever).
 */

import { join } from 'node:path';
import { Agent, CapabilityError, ErrorClass, agentTaskQueue } from '@acp/agent-sdk';
import { NativeConnection, Worker } from '@temporalio/worker';
import { repoRoot } from './platform.js';

/** The approval-test-agent registers and activates at 0.1.0 (registerAndActivate). */
const APPROVAL_AGENT_VERSION = '0.1.0';

export const APPROVAL_AGENT_ID = 'approval-test-agent';
export const APPROVAL_MANIFEST_PATH = join(
  repoRoot,
  'tests',
  'e2e',
  'fixtures',
  'approval-test-agent.manifest.yaml',
);

export interface RunningAgent {
  shutdown(): Promise<void>;
  /** Every capability invocation, in order — the compensation slice asserts the undo call + its {original} input. */
  readonly calls: { capability: string; input: Record<string, unknown> }[];
}

/** Starts the in-process approval-test-agent worker; resolves once it is polling. */
export async function startApprovalAgent(): Promise<RunningAgent> {
  const agent = Agent.fromManifest(APPROVAL_MANIFEST_PATH);
  const calls: { capability: string; input: Record<string, unknown> }[] = [];

  // Canned handlers: return a valid Answer envelope so the task synthesizes to
  // completed. The point under test is governance (approval + compensation),
  // not the content. Every call is recorded so the compensation slice can
  // assert gov.test_undo ran with the {original} write context.
  const canned =
    (verb: string, capability: string) => (_ctx: unknown, input: Record<string, unknown>) => {
      calls.push({ capability, input });
      const target = typeof input.target === 'string' ? input.target : 'record';
      return Promise.resolve({
        text: `${verb} applied to ${target} [1]`,
        citations: [
          {
            doc_id: 'gov/change-log',
            version: '1',
            lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3faa',
          },
        ],
        confidence: 0.95,
      });
    };
  agent.capability('gov.test_write', canned('write', 'gov.test_write'));
  agent.capability('gov.test_undo', canned('undo', 'gov.test_undo'));
  // Always fails permanently — used to trigger a saga unwind of the write.
  agent.capability('gov.test_fail', (_ctx: unknown, input: Record<string, unknown>) => {
    calls.push({ capability: 'gov.test_fail', input });
    return Promise.reject(
      new CapabilityError(
        ErrorClass.Permanent,
        'gov.test_fail always fails (compensation trigger)',
      ),
    );
  });
  // Sleeps then fails — the kill-switch-audit slice uses the sleep window to flip
  // a risk-class kill switch after the preceding write completed, so the unwind
  // runs under an active R2 flag (exemption matrix).
  agent.capability('gov.test_slow_fail', async (_ctx: unknown, input: Record<string, unknown>) => {
    calls.push({ capability: 'gov.test_slow_fail', input });
    const sleepMs = typeof input.sleep_ms === 'number' ? input.sleep_ms : 6000;
    await new Promise((r) => setTimeout(r, sleepMs));
    throw new CapabilityError(
      ErrorClass.Permanent,
      'gov.test_slow_fail always fails after sleeping (compensation trigger)',
    );
  });

  const connection = await NativeConnection.connect({
    address: process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.ACP_TEMPORAL_NAMESPACE ?? 'default',
    // Version-qualified queue (item 4) — computed explicitly so this in-process
    // worker needs no ACP_AGENT_VERSION env; matches the registered 0.1.0 card.
    taskQueue: agentTaskQueue(agent.agentId, APPROVAL_AGENT_VERSION),
    activities: {
      execute_capability: (request: unknown) => agent.execute(request),
    },
  });
  // run() resolves when shutdown() is called; keep the handle to await it.
  const running = worker.run();
  return {
    calls,
    async shutdown() {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}
