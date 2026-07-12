import { createRequire } from 'node:module';
import type { AgentCard, StepRequest, StepResult, TaskRequest, TaskResult } from '@acp/protocol';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskWorkflow } from '../src/workflows.js';
import { CONTROL_TASK_QUEUE, agentTaskQueue, type ControlActivities } from '../src/types.js';

const require = createRequire(import.meta.url);

const card: AgentCard = {
  manifest: {
    id: 'knowledge-agent',
    name: 'Knowledge & Policy Agent',
    owner: 'team-platform',
    description: 'Cited answers.',
    capabilities: [
      {
        name: 'knowledge.answer_with_citations',
        description: 'Answer with citations.',
        risk: 'R0',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        examples: [{ input: {} }, { input: {} }, { input: {} }],
        sla: { p95_latency_s: 5 },
      },
    ],
    tools: [{ server: 'knowledge-store', scopes: ['knowledge:search:read'] }],
  },
  version: '0.1.0',
  lifecycle_state: 'active',
  registered_at: '2026-07-10T08:00:00Z',
  updated_at: '2026-07-10T08:00:00Z',
  card_signature: 'sig',
};

const task: TaskRequest = {
  kind: 'task_request',
  task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
  tenant: 'acme',
  principal: 'user:jane.doe',
  input: { text: 'What does our policy say about change freezes?' },
  subject_token: 'subject.jwt.value',
};

let env: TestWorkflowEnvironment;

const audited: Record<string, unknown>[] = [];
const control: ControlActivities = {
  discoverAgent: vi.fn(),
  authorizeDelegation: vi.fn(),
  exchangeToken: vi.fn(),
  emitAudit: vi.fn((e: Record<string, unknown>) => {
    audited.push(e);
    return Promise.resolve();
  }),
};
const executeCapability = vi.fn<(req: StepRequest) => Promise<StepResult>>();

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 240_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(() => {
  vi.mocked(control.discoverAgent).mockReset().mockResolvedValue(card);
  vi.mocked(control.authorizeDelegation)
    .mockReset()
    .mockResolvedValue({
      decision: 'allow',
      bundle_version: '2026.07+abc',
      determining_policies: ['allow-r0-delegation'],
    });
  vi.mocked(control.exchangeToken).mockReset().mockResolvedValue({ token: 'delegated.jwt' });
  executeCapability.mockReset();
  audited.length = 0;
});

async function runTask(input: TaskRequest): Promise<TaskResult> {
  const namespace = env.namespace ?? 'default';
  const controlWorker = await Worker.create({
    connection: env.nativeConnection,
    namespace,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowsPath: require.resolve('../src/workflows.ts'),
    activities: { ...control },
  });
  const agentWorker = await Worker.create({
    connection: env.nativeConnection,
    namespace,
    taskQueue: agentTaskQueue('knowledge-agent'),
    activities: { execute_capability: executeCapability },
  });
  return controlWorker.runUntil(() =>
    agentWorker.runUntil(() =>
      env.client.workflow.execute(TaskWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: `test-${Math.random().toString(36).slice(2)}`,
        args: [input],
      }),
    ),
  );
}

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    kind: 'step_result',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    task_id: task.task_id,
    tenant: 'acme',
    status: 'completed',
    output: {
      text: 'A change freeze is in effect during the final week of each fiscal quarter [1].',
      citations: [
        {
          doc_id: 'policy/change-management',
          version: '3.2.0',
          lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
        },
      ],
      confidence: 0.91,
    },
    usage: { input_tokens: 900, output_tokens: 120, llm_calls: 1 },
    ...overrides,
  };
}

describe('TaskWorkflow', () => {
  it('discovers, authorizes, exchanges, dispatches, and synthesizes a cited answer', async () => {
    executeCapability.mockImplementation((req) => {
      // The polyglot contract: the delegated token and capability arrive
      // in the StepRequest the Python worker will receive.
      expect(req.delegated_token).toBe('delegated.jwt');
      expect(req.capability).toBe('knowledge.answer_with_citations');
      expect(req.input).toEqual({ question: task.input.text });
      return Promise.resolve(stepResult({ step_id: req.step_id }));
    });

    const result = await runTask(task);
    expect(result.status).toBe('completed');
    expect(result.answer?.citations).toHaveLength(1);
    expect(result.answer?.confidence).toBeGreaterThan(0.9);

    expect(control.discoverAgent).toHaveBeenCalledWith('knowledge.answer_with_citations', 'acme');
    expect(audited.map((e) => e.event_type)).toEqual(['step.dispatched', 'step.completed']);
  });

  it('fails honestly when no active agent serves the capability (kill-switch path)', async () => {
    vi.mocked(control.discoverAgent).mockResolvedValue(null);
    const result = await runTask(task);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('suspended or not yet promoted');
    expect(executeCapability).not.toHaveBeenCalled();
  });

  it('stops at a policy deny: no token exchange, no dispatch, typed policy_denied error', async () => {
    vi.mocked(control.authorizeDelegation).mockResolvedValue({
      decision: 'deny',
      bundle_version: '2026.07+abc',
      determining_policies: [],
    });
    const result = await runTask(task);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('policy_denied');
    expect(control.exchangeToken).not.toHaveBeenCalled();
    expect(executeCapability).not.toHaveBeenCalled();
  });

  it('fails when the gateway forwarded no subject token', async () => {
    const rest = { ...task };
    delete rest.subject_token;
    const result = await runTask(rest);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('subject_token');
    expect(executeCapability).not.toHaveBeenCalled();
  });

  it('retries a transiently failing agent activity and succeeds', async () => {
    executeCapability
      .mockRejectedValueOnce(new Error('LLM provider 429'))
      .mockImplementation((req) => Promise.resolve(stepResult({ step_id: req.step_id })));
    const result = await runTask(task);
    expect(result.status).toBe('completed');
    expect(executeCapability).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed step as a failed task with the agent error', async () => {
    const failed = stepResult({
      status: 'failed',
      error: { class: 'needs_input', message: 'question is ambiguous: which policy?' },
    });
    delete failed.output;
    executeCapability.mockResolvedValue(failed);
    const result = await runTask(task);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('needs_input');
  });
});
