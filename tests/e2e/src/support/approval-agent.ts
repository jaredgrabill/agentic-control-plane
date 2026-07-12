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
import { Agent } from '@acp/agent-sdk';
import { NativeConnection, Worker } from '@temporalio/worker';
import { repoRoot } from './platform.js';

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
}

/** Starts the in-process approval-test-agent worker; resolves once it is polling. */
export async function startApprovalAgent(): Promise<RunningAgent> {
  const agent = Agent.fromManifest(APPROVAL_MANIFEST_PATH);

  // Canned handlers: return a valid Answer envelope so the task synthesizes to
  // completed. The point under test is that the write only runs AFTER a human
  // approval — the content is incidental.
  const canned = (verb: string) => (_ctx: unknown, input: Record<string, unknown>) => {
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
  agent.capability('gov.test_write', canned('write'));
  agent.capability('gov.test_undo', canned('undo'));

  const connection = await NativeConnection.connect({
    address: process.env.ACP_TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.ACP_TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: agent.taskQueue,
    activities: {
      execute_capability: (request: unknown) => agent.execute(request),
    },
  });
  // run() resolves when shutdown() is called; keep the handle to await it.
  const running = worker.run();
  return {
    async shutdown() {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}
