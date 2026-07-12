import { createRequire } from 'node:module';
import type {
  AgentCard,
  Plan,
  StepRequest,
  StepResult,
  TaskRequest,
  TaskResult,
} from '@acp/protocol';
import type { ResolvedPriceBook } from '@acp/cost-meter/pricing';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStepWorkflow, TaskWorkflow } from '../src/workflows.js';
import {
  CONTROL_TASK_QUEUE,
  agentTaskQueue,
  type ControlActivities,
  type PrincipalSnapshot,
  type StepDispatch,
} from '../src/types.js';

const TASK_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
const STEP_IDS = [
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f52',
] as const;
const PLAN_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f50';
const DIGEST = `sha256:${'0'.repeat(64)}`;

function makeCard(id: string, capability: string, scopes: [string, ...string[]]): AgentCard {
  return {
    manifest: {
      id,
      name: id,
      owner: 'team-platform',
      description: 'Test agent.',
      capabilities: [
        {
          name: capability,
          description: 'Test capability.',
          risk: 'R0',
          input_schema: { type: 'object' },
          output_schema: { type: 'object' },
          examples: [{ input: {} }, { input: {} }, { input: {} }],
          sla: { p95_latency_s: 5 },
        },
      ],
      tools: [{ server: `${id}-tools`, scopes }],
    },
    version: '0.1.0',
    lifecycle_state: 'active',
    registered_at: '2026-07-10T08:00:00Z',
    updated_at: '2026-07-10T08:00:00Z',
    card_signature: 'sig',
  };
}

const knowledgeCard = makeCard('knowledge-agent', 'knowledge.answer_with_citations', [
  'knowledge:search:read',
]);
const cloudCard = makeCard('cloud-agent', 'cloud.cost_analysis', ['cloud:cost:read']);
const codeCard = makeCard('code-agent', 'code.ci_health', ['code:ci:read']);
const CARDS: Record<string, AgentCard> = {
  'knowledge.answer_with_citations': knowledgeCard,
  'cloud.cost_analysis': cloudCard,
  'code.ci_health': codeCard,
};

const snapshot: PrincipalSnapshot = {
  sub: 'user:jane.doe',
  tenant: 'acme',
  roles: ['tenant-user'],
  scopes: ['task:submit', 'knowledge:search:read', 'cloud:cost:read', 'code:ci:read'],
  jti: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
  verified_at: '2026-07-11T09:00:00Z',
};

const task: TaskRequest = {
  kind: 'task_request',
  task_id: TASK_ID,
  tenant: 'acme',
  principal: 'user:jane.doe',
  input: { text: 'What does our policy say about change freezes?' },
  subject_token: 'subject.jwt.value',
};

function makePlan(
  specs: {
    capability: string;
    input: Record<string, unknown>;
    dependsOnIndex?: number[];
  }[],
): Plan {
  const steps = specs.map((spec, i) => ({
    step_id: STEP_IDS[i]!,
    capability: spec.capability,
    input: spec.input,
    ...(spec.dependsOnIndex === undefined
      ? {}
      : { depends_on: spec.dependsOnIndex.map((d) => STEP_IDS[d]!) }),
  }));
  return {
    plan_id: PLAN_ID,
    task_id: TASK_ID,
    tenant: 'acme',
    planner: 'rule-planner@1',
    steps: steps as Plan['steps'],
    created_at: '2026-07-11T09:00:00Z',
  };
}

const knowledgePlan = makePlan([
  { capability: 'knowledge.answer_with_citations', input: { question: task.input.text } },
]);
const fanOutPlan = makePlan([
  { capability: 'cloud.cost_analysis', input: {} },
  { capability: 'code.ci_health', input: { repo: 'acme/payments-service' } },
]);
const dependentPlan = makePlan([
  { capability: 'cloud.cost_analysis', input: {} },
  { capability: 'code.ci_health', input: { repo: 'acme/payments-service' }, dependsOnIndex: [0] },
]);

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

const audited: Record<string, unknown>[] = [];
const control: ControlActivities = {
  snapshotPrincipal: vi.fn(),
  planTask: vi.fn(),
  discoverAgent: vi.fn(),
  authorizeDelegation: vi.fn(),
  brokerToken: vi.fn(),
  emitAudit: vi.fn((e: Record<string, unknown>) => {
    audited.push(e);
    return Promise.resolve();
  }),
  getPriceBook: vi.fn(),
};

// Resolved books (integer micro-USD/MTok), as the loader would produce.
const ZERO_MICROS = {
  inputMicrosPerMTok: 0,
  outputMicrosPerMTok: 0,
  cacheReadMicrosPerMTok: 0,
  cacheWriteMicrosPerMTok: 0,
};
// The default for existing regression tests: every usage prices to $0, so
// max_cost_usd passes through untouched and cost recording is a no-op.
const zeroBook: ResolvedPriceBook = { version: 'test-zero', models: {}, fallback: ZERO_MICROS };
// A priced book: dev-echo@1 known, plus non-zero fallback for unknown models.
const pricedBook: ResolvedPriceBook = {
  version: 'test-2026-07',
  models: {
    'dev-echo@1': {
      inputMicrosPerMTok: 1_000_000, // $1/MTok
      outputMicrosPerMTok: 2_000_000, // $2/MTok
      cacheReadMicrosPerMTok: 100_000,
      cacheWriteMicrosPerMTok: 1_250_000,
    },
  },
  fallback: {
    inputMicrosPerMTok: 5_000_000, // $5/MTok
    outputMicrosPerMTok: 25_000_000, // $25/MTok
    cacheReadMicrosPerMTok: 500_000,
    cacheWriteMicrosPerMTok: 6_250_000,
  },
};

type Handler = (req: StepRequest) => Promise<StepResult>;
const knowledgeExec = vi.fn<Handler>();
const cloudExec = vi.fn<Handler>();
const codeExec = vi.fn<Handler>();
const HANDLERS: Record<string, ReturnType<typeof vi.fn<Handler>>> = {
  'knowledge-agent': knowledgeExec,
  'cloud-agent': cloudExec,
  'code-agent': codeExec,
};

const require = createRequire(import.meta.url);

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  // Bundle once for the whole file: every test's control worker reuses it.
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: require.resolve('../src/workflows.ts'),
  });
}, 240_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(() => {
  vi.mocked(control.snapshotPrincipal).mockReset().mockResolvedValue(snapshot);
  vi.mocked(control.planTask)
    .mockReset()
    .mockResolvedValue({ plan: knowledgePlan, planDigest: DIGEST });
  vi.mocked(control.discoverAgent)
    .mockReset()
    .mockImplementation((capability: string) => Promise.resolve(CARDS[capability] ?? null));
  vi.mocked(control.authorizeDelegation)
    .mockReset()
    .mockResolvedValue({
      decision: 'allow',
      bundle_version: '2026.07+abc',
      determining_policies: ['allow-r0-delegation'],
    });
  vi.mocked(control.brokerToken).mockReset().mockResolvedValue({ token: 'brokered.jwt' });
  vi.mocked(control.getPriceBook).mockReset().mockResolvedValue(zeroBook);
  knowledgeExec.mockReset();
  cloudExec.mockReset();
  codeExec.mockReset();
  audited.length = 0;
});

async function withWorkers<T>(agentIds: string[], run: () => Promise<T>): Promise<T> {
  const namespace = env.namespace ?? 'default';
  const controlWorker = await Worker.create({
    connection: env.nativeConnection,
    namespace,
    taskQueue: CONTROL_TASK_QUEUE,
    workflowBundle,
    activities: { ...control },
  });
  const agentWorkers = await Promise.all(
    agentIds.map((id) =>
      Worker.create({
        connection: env.nativeConnection,
        namespace,
        taskQueue: agentTaskQueue(id),
        activities: { execute_capability: HANDLERS[id]! },
      }),
    ),
  );
  const nested = agentWorkers.reduceRight<() => Promise<T>>(
    (inner, worker) => () => worker.runUntil(inner),
    run,
  );
  return controlWorker.runUntil(nested);
}

const workflowId = (): string => `test-${Math.random().toString(36).slice(2)}`;

async function runTask(input: TaskRequest, agentIds: string[]): Promise<TaskResult> {
  return withWorkers(agentIds, () =>
    env.client.workflow.execute(TaskWorkflow, {
      taskQueue: CONTROL_TASK_QUEUE,
      workflowId: workflowId(),
      args: [input],
    }),
  );
}

function answerOutput(text: string, docIds: string[], confidence: number): Record<string, unknown> {
  return {
    text,
    citations: docIds.map((doc_id) => ({
      doc_id,
      version: '1.0.0',
      lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
    })),
    confidence,
  };
}

function completedStep(
  req: StepRequest,
  output: Record<string, unknown>,
  usage: StepResult['usage'] = { input_tokens: 900, output_tokens: 120, llm_calls: 0 },
): StepResult {
  return {
    kind: 'step_result',
    step_id: req.step_id,
    task_id: req.task_id,
    tenant: req.tenant,
    status: 'completed',
    output,
    usage,
  };
}

function failedStep(req: StepRequest, error: NonNullable<StepResult['error']>): StepResult {
  return {
    kind: 'step_result',
    step_id: req.step_id,
    task_id: req.task_id,
    tenant: req.tenant,
    status: 'failed',
    error,
  };
}

const COST_TEXT = 'Total spend rose 30.0% [1], driven by payments-api [2].';
const CI_TEXT = 'Pass rate dipped after deploy d-2026-07-01-042 [1].';

function scriptCloudAndCode(): void {
  cloudExec.mockImplementation((req) =>
    Promise.resolve(
      completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report', 'cloud/inventory'], 0.8), {
        input_tokens: 300,
        output_tokens: 0,
        llm_calls: 0,
      }),
    ),
  );
  codeExec.mockImplementation((req) =>
    Promise.resolve(
      completedStep(req, answerOutput(CI_TEXT, ['code/ci-activity'], 0.9), {
        input_tokens: 200,
        output_tokens: 0,
        llm_calls: 0,
      }),
    ),
  );
}

describe('TaskWorkflow v1', () => {
  it('(1) single-capability fast path: v0 parity, plan recorded, audit order', async () => {
    knowledgeExec.mockImplementation((req) => {
      // The polyglot contract: the brokered token, capability, depth, and
      // the PLANNED input arrive in the StepRequest.
      expect(req.delegated_token).toBe('brokered.jwt');
      expect(req.capability).toBe('knowledge.answer_with_citations');
      expect(req.input).toEqual({ question: task.input.text });
      expect(req.delegation_depth).toBe(1);
      return Promise.resolve(
        completedStep(
          req,
          answerOutput(
            'A change freeze is in effect during the final week of each fiscal quarter [1].',
            ['policy/change-management'],
            0.91,
          ),
        ),
      );
    });

    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('completed');
    // Single-step plans pass the answer through untouched — no attribution
    // header, no renumbering. v0 parity.
    expect(result.answer?.text).toContain('fiscal quarter');
    expect(result.answer?.text.startsWith('[')).toBe(false);
    expect(result.answer?.citations).toHaveLength(1);
    expect(result.answer?.confidence).toBeGreaterThan(0.9);
    expect(result.plan?.plan_id).toBe(PLAN_ID);
    expect(result.gaps).toBeUndefined();

    expect(control.discoverAgent).toHaveBeenCalledWith('knowledge.answer_with_citations', 'acme');
    expect(audited.map((e) => e.event_type)).toEqual([
      'task.planned',
      'step.dispatched',
      'step.completed',
      'task.completed',
    ]);
    const planned = audited[0]!;
    expect((planned.details as { plan: Plan }).plan.plan_id).toBe(PLAN_ID);
    expect((planned.action as { outputs_digest: string }).outputs_digest).toBe(DIGEST);
  });

  it('(2) fan-out happy path: parallel sections, renumbered markers, one snapshot, two brokered mints', async () => {
    vi.mocked(control.planTask).mockResolvedValue({ plan: fanOutPlan, planDigest: DIGEST });
    scriptCloudAndCode();

    const result = await runTask(task, ['cloud-agent', 'code-agent']);
    expect(result.status).toBe('completed');

    const sections = result.answer!.text.split('\n\n');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toBe(`[cloud.cost_analysis]\n${COST_TEXT}`);
    // The CI section's [1] renumbers to [3]: two cost citations precede it.
    expect(sections[1]).toBe(
      '[code.ci_health]\nPass rate dipped after deploy d-2026-07-01-042 [3].',
    );
    expect(result.answer!.citations.map((c) => c.doc_id)).toEqual([
      'cloud/cost-report',
      'cloud/inventory',
      'code/ci-activity',
    ]);
    expect(result.answer!.confidence).toBe(0.8);

    // ADR-0007: the subject token is consumed exactly once, at intake; each
    // step mints its own brokered token from the snapshot.
    expect(control.snapshotPrincipal).toHaveBeenCalledTimes(1);
    expect(control.brokerToken).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(control.brokerToken).mock.calls) {
      expect(input.snapshot).toEqual(snapshot);
      expect(JSON.stringify(input)).not.toContain('subject.jwt.value');
    }
    for (const [input] of vi.mocked(control.authorizeDelegation).mock.calls) {
      expect(JSON.stringify(input)).not.toContain('subject.jwt.value');
    }
  });

  it('(3) dependency ordering: the dependent step dispatches only after its dependency completes', async () => {
    vi.mocked(control.planTask).mockResolvedValue({ plan: dependentPlan, planDigest: DIGEST });
    const order: string[] = [];
    cloudExec.mockImplementation((req) => {
      order.push('cloud.cost_analysis');
      return Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8)),
      );
    });
    codeExec.mockImplementation((req) => {
      order.push('code.ci_health');
      return Promise.resolve(completedStep(req, answerOutput(CI_TEXT, ['code/ci-activity'], 0.9)));
    });

    const result = await runTask(task, ['cloud-agent', 'code-agent']);
    expect(result.status).toBe('completed');
    expect(order).toEqual(['cloud.cost_analysis', 'code.ci_health']);
  });

  it('(4) partial results: a failed branch becomes a gap, survivors still answer', async () => {
    vi.mocked(control.planTask).mockResolvedValue({ plan: fanOutPlan, planDigest: DIGEST });
    cloudExec.mockImplementation((req) =>
      Promise.resolve(completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8))),
    );
    codeExec.mockImplementation((req) =>
      Promise.resolve(failedStep(req, { class: 'needs_input', message: 'repo is required' })),
    );

    const result = await runTask(task, ['cloud-agent', 'code-agent']);
    expect(result.status).toBe('partial');
    expect(result.answer!.text).toContain('30.0');
    expect(result.gaps).toEqual(['code.ci_health: repo is required']);
    expect(result.error).toBeUndefined();
  });

  it('(5) dependent skip: a failed dependency skips the dependent without dispatching it', async () => {
    vi.mocked(control.planTask).mockResolvedValue({ plan: dependentPlan, planDigest: DIGEST });
    cloudExec.mockImplementation((req) =>
      Promise.resolve(failedStep(req, { class: 'permanent', message: 'cost report missing' })),
    );

    const result = await runTask(task, ['cloud-agent', 'code-agent']);
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ class: 'permanent', message: 'cost report missing' });
    expect(codeExec).not.toHaveBeenCalled();

    const skippedEvents = audited.filter((e) => e.event_type === 'step.skipped');
    expect(skippedEvents).toHaveLength(1);
    expect((skippedEvents[0]!.details as { gap: string }).gap).toBe(
      'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
    );
    expect(result.gaps).toContain(
      'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
    );
  });

  it('(6) depth cap breach: a planning failure, before discovery or minting', async () => {
    const dispatch: StepDispatch = {
      taskId: TASK_ID,
      tenant: 'acme',
      principal: 'user:jane.doe',
      snapshot,
      planStep: fanOutPlan.steps[0],
      planRef: { planId: PLAN_ID, index: 0, total: 2 },
      depth: 4,
    };
    const result = await withWorkers([], () =>
      env.client.workflow.execute(AgentStepWorkflow, {
        taskQueue: CONTROL_TASK_QUEUE,
        workflowId: workflowId(),
        args: [dispatch],
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
    expect(result.error?.message).toContain('delegation depth 4 exceeds the platform cap 3');
    expect(result.error?.message).toContain('planning failure, not a retry');
    expect(control.discoverAgent).not.toHaveBeenCalled();
    expect(control.brokerToken).not.toHaveBeenCalled();
  });

  it('(7) budget max_steps: dispatch gates, the remainder becomes budget gaps', async () => {
    vi.mocked(control.planTask).mockResolvedValue({ plan: fanOutPlan, planDigest: DIGEST });
    scriptCloudAndCode();

    const result = await runTask({ ...task, budget: { max_steps: 1 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(result.status).toBe('partial');
    expect(result.answer!.text).toContain('30.0');
    expect(result.error).toEqual({
      class: 'budget_exhausted',
      message: 'budget exhausted after step 1 of 2: max_steps 1 reached',
    });
    expect(result.gaps).toEqual([
      'budget exhausted after step 1 of 2: max_steps 1 reached — code.ci_health not executed',
    ]);
    expect(cloudExec).toHaveBeenCalledTimes(1);
    expect(codeExec).not.toHaveBeenCalled();
    expect(audited.filter((e) => e.event_type === 'step.skipped')).toHaveLength(1);
  });

  it('(8) budget max_tokens: steps carry the REMAINING budget; exhaustion stops the next wave', async () => {
    // Two waves via the dependent plan. First: remaining forwarded.
    vi.mocked(control.planTask).mockResolvedValue({ plan: dependentPlan, planDigest: DIGEST });
    const forwarded: (StepRequest['budget'] | undefined)[] = [];
    cloudExec.mockImplementation((req) => {
      forwarded.push(req.budget);
      return Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8), {
          input_tokens: 300,
          output_tokens: 0,
          llm_calls: 0,
        }),
      );
    });
    codeExec.mockImplementation((req) => {
      forwarded.push(req.budget);
      return Promise.resolve(completedStep(req, answerOutput(CI_TEXT, ['code/ci-activity'], 0.9)));
    });

    const ok = await runTask({ ...task, budget: { max_tokens: 1000, max_cost_usd: 5 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(ok.status).toBe('completed');
    // Wave 1 sees the full budget; wave 2 sees what wave 1 left over.
    // max_cost_usd passes through (recorded, not enforced); max_steps never forwards.
    expect(forwarded).toEqual([
      { max_tokens: 1000, max_cost_usd: 5 },
      { max_tokens: 700, max_cost_usd: 5 },
    ]);

    // Second run: wave 1 eats the whole token budget — wave 2 never dispatches.
    codeExec.mockClear();
    cloudExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8), {
          input_tokens: 900,
          output_tokens: 300,
          llm_calls: 0,
        }),
      ),
    );
    const exhausted = await runTask({ ...task, budget: { max_tokens: 1000 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(exhausted.status).toBe('partial');
    expect(exhausted.error).toEqual({
      class: 'budget_exhausted',
      message: 'budget exhausted after step 1 of 2: max_tokens 1000 reached',
    });
    expect(exhausted.gaps).toEqual([
      'budget exhausted after step 1 of 2: max_tokens 1000 reached — code.ci_health not executed',
    ]);
    expect(codeExec).not.toHaveBeenCalled();
  });

  it('(9) fails when the gateway forwarded no subject token — before any verification', async () => {
    const rest = { ...task };
    delete rest.subject_token;
    const result = await runTask(rest, []);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('subject_token');
    expect(control.snapshotPrincipal).not.toHaveBeenCalled();
    expect(control.planTask).not.toHaveBeenCalled();
  });

  it('(10) non-Answer output: the envelope guard fails the step honestly', async () => {
    knowledgeExec.mockImplementation((req) => Promise.resolve(completedStep(req, { rows: [1] })));
    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('not an Answer envelope');
    expect(result.gaps).toEqual([
      'knowledge.answer_with_citations: step output was not an Answer envelope',
    ]);
  });

  it('(11) retry parity: a transiently failing agent activity retries and succeeds', async () => {
    knowledgeExec
      .mockRejectedValueOnce(new Error('LLM provider 429'))
      .mockImplementation((req) =>
        Promise.resolve(
          completedStep(req, answerOutput('Answer [1].', ['policy/change-management'], 0.9)),
        ),
      );
    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('completed');
    expect(knowledgeExec).toHaveBeenCalledTimes(2);
  });

  it('fails honestly when no active agent serves the capability (kill-switch path)', async () => {
    vi.mocked(control.discoverAgent).mockResolvedValue(null);
    const result = await runTask(task, []);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('suspended or not yet promoted');
    expect(knowledgeExec).not.toHaveBeenCalled();
  });

  it('stops at a policy deny: no brokered token, no dispatch, typed policy_denied error', async () => {
    vi.mocked(control.authorizeDelegation).mockResolvedValue({
      decision: 'deny',
      bundle_version: '2026.07+abc',
      determining_policies: [],
    });
    const result = await runTask(task, []);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('policy_denied');
    expect(control.brokerToken).not.toHaveBeenCalled();
    expect(knowledgeExec).not.toHaveBeenCalled();
  });

  it('fails permanently when intake verification rejects the subject token', async () => {
    vi.mocked(control.snapshotPrincipal).mockRejectedValue(
      ApplicationFailure.nonRetryable('subject token failed intake verification: expired'),
    );
    const result = await runTask(task, []);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('permanent');
    expect(result.error?.message).toContain('intake verification');
    expect(control.planTask).not.toHaveBeenCalled();
  });
});

describe('TaskWorkflow cost meter', () => {
  const completedAudit = () =>
    audited.find((e) => e.event_type === 'task.completed')!.details as {
      usage_totals: { cost_usd: number | null };
      price_book_version: string | null;
      cost_fallback_priced?: boolean;
      steps: { capability: string; cost_usd?: number }[];
    };

  // Usage carrying a concrete model id (dev-echo@1 is priced in pricedBook).
  const usageWith = (input: number, output: number, model = 'dev-echo@1'): StepResult['usage'] => ({
    input_tokens: input,
    output_tokens: output,
    llm_calls: 1,
    model,
  });

  it('(1) cost gate trips: a step whose cost meets the budget skips the remainder', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    vi.mocked(control.planTask).mockResolvedValue({ plan: dependentPlan, planDigest: DIGEST });
    // Step 1: 2000 in @ $1/MTok = 2000 micros = $0.002 ≥ the $0.001 budget.
    cloudExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8), usageWith(2000, 0)),
      ),
    );

    const result = await runTask({ ...task, budget: { max_cost_usd: 0.001 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(result.status).toBe('partial');
    expect(result.error).toEqual({
      class: 'budget_exhausted',
      message: 'budget exhausted after step 1 of 2: max_cost_usd 0.001 reached',
    });
    expect(result.gaps).toEqual([
      'budget exhausted after step 1 of 2: max_cost_usd 0.001 reached — code.ci_health not executed',
    ]);
    expect(codeExec).not.toHaveBeenCalled();
    expect(audited.filter((e) => e.event_type === 'step.skipped')).toHaveLength(1);

    const details = completedAudit();
    expect(details.usage_totals.cost_usd).toBe(0.002);
    expect(details.price_book_version).toBe('test-2026-07');
    const cloudStep = details.steps.find((s) => s.capability === 'cloud.cost_analysis');
    expect(cloudStep?.cost_usd).toBe(0.002);
  });

  it('(2) honest overshoot: a parallel wave that clears the gate at dispatch is kept whole', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    vi.mocked(control.planTask).mockResolvedValue({ plan: fanOutPlan, planDigest: DIGEST });
    // Each step $0.002; combined $0.004 overshoots the $0.003 budget — but the
    // gate sees $0 at dispatch, so both dispatch and both are kept.
    cloudExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8), usageWith(2000, 0)),
      ),
    );
    codeExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput(CI_TEXT, ['code/ci-activity'], 0.9), usageWith(2000, 0)),
      ),
    );

    const result = await runTask({ ...task, budget: { max_cost_usd: 0.003 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(cloudExec).toHaveBeenCalledTimes(1);
    expect(codeExec).toHaveBeenCalledTimes(1);

    const details = completedAudit();
    // Recorded cost overshoots the budget honestly.
    expect(details.usage_totals.cost_usd).toBe(0.004);
    expect(details.usage_totals.cost_usd! > 0.003).toBe(true);
  });

  it('(3) remaining budget decrements: step 2 carries budget minus step 1 cost (micro-exact)', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    vi.mocked(control.planTask).mockResolvedValue({ plan: dependentPlan, planDigest: DIGEST });
    const forwarded: (StepRequest['budget'] | undefined)[] = [];
    cloudExec.mockImplementation((req) => {
      forwarded.push(req.budget);
      // 2000 in @ $1/MTok = $0.002.
      return Promise.resolve(
        completedStep(req, answerOutput(COST_TEXT, ['cloud/cost-report'], 0.8), usageWith(2000, 0)),
      );
    });
    codeExec.mockImplementation((req) => {
      forwarded.push(req.budget);
      return Promise.resolve(
        completedStep(req, answerOutput(CI_TEXT, ['code/ci-activity'], 0.9), usageWith(0, 0)),
      );
    });

    const result = await runTask({ ...task, budget: { max_cost_usd: 0.01 } }, [
      'cloud-agent',
      'code-agent',
    ]);
    expect(result.status).toBe('completed');
    // Wave 1 sees the full $0.01; wave 2 sees $0.01 − $0.002 = $0.008.
    expect(forwarded).toEqual([{ max_cost_usd: 0.01 }, { max_cost_usd: 0.008 }]);
  });

  it('(4) zero-LLM: no tokens cost nothing, and the gate never trips even at a tiny budget', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    knowledgeExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput('answer [1].', ['policy/change-management'], 0.9), {
          input_tokens: 0,
          output_tokens: 0,
          llm_calls: 0,
        }),
      ),
    );

    const result = await runTask({ ...task, budget: { max_cost_usd: 0.000001 } }, [
      'knowledge-agent',
    ]);
    expect(result.status).toBe('completed');
    expect(knowledgeExec).toHaveBeenCalledTimes(1);
    expect(completedAudit().usage_totals.cost_usd).toBe(0);
  });

  it('(5) fallback pricing: usage without a model prices on the fallback and is flagged', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    knowledgeExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput('answer [1].', ['policy/change-management'], 0.9), {
          // No model → fallback $5/MTok: 1000 in = $0.005.
          input_tokens: 1000,
          output_tokens: 0,
          llm_calls: 1,
        }),
      ),
    );

    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('completed');
    const details = completedAudit();
    expect(details.usage_totals.cost_usd).toBe(0.005);
    expect(details.cost_fallback_priced).toBe(true);
  });

  it('(6) records cost without a cost budget: no enforcement, still priced and versioned', async () => {
    vi.mocked(control.getPriceBook).mockResolvedValue(pricedBook);
    knowledgeExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(
          req,
          answerOutput('answer [1].', ['policy/change-management'], 0.9),
          usageWith(1000, 0), // 1000 in @ $1/MTok = $0.001
        ),
      ),
    );

    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('completed');
    const details = completedAudit();
    expect(details.usage_totals.cost_usd).toBe(0.001);
    expect(details.price_book_version).toBe('test-2026-07');
    expect(details.cost_fallback_priced).toBeUndefined();
  });

  it('(7a) fault injection with a cost budget: fail closed, name the price book, dispatch nothing', async () => {
    vi.mocked(control.getPriceBook).mockRejectedValue(
      ApplicationFailure.nonRetryable('price book activity blew up'),
    );

    const result = await runTask({ ...task, budget: { max_cost_usd: 0.01 } }, ['knowledge-agent']);
    expect(result.status).toBe('failed');
    expect(result.error?.class).toBe('retryable');
    expect(result.error?.message).toContain('price book unavailable');
    expect(control.brokerToken).not.toHaveBeenCalled();
    expect(knowledgeExec).not.toHaveBeenCalled();
    expect(audited.some((e) => e.event_type === 'task.completed')).toBe(false);
  });

  it('(7b) fault injection without a cost budget: proceed, cost null, version null', async () => {
    vi.mocked(control.getPriceBook).mockRejectedValue(
      ApplicationFailure.nonRetryable('price book activity blew up'),
    );
    knowledgeExec.mockImplementation((req) =>
      Promise.resolve(
        completedStep(req, answerOutput('answer [1].', ['policy/change-management'], 0.9)),
      ),
    );

    const result = await runTask(task, ['knowledge-agent']);
    expect(result.status).toBe('completed');
    const details = completedAudit();
    expect(details.usage_totals.cost_usd).toBeNull();
    expect(details.price_book_version).toBeNull();
  });
});
