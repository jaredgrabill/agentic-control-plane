/**
 * Deterministic workflow code (Temporal V8 isolate): no IO, no wall clocks
 * beyond the patched Date, no randomness beyond uuid4(). Everything
 * effectful is an activity.
 *
 * v1 flow (plan-then-execute, ADR-0007): snapshot the principal once at
 * intake → materialize a typed plan → record it (task.planned) → execute
 * dependency waves under the budget ledger → synthesize with honest gaps.
 */
import {
  ApplicationFailure,
  executeChild,
  proxyActivities,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  AgentCard,
  Budget,
  CapabilityError,
  PlanStep,
  StepRequest,
  StepResult,
  TaskRequest,
  TaskResult,
} from '@acp/protocol';
import { synthesizeAnswer, type StepOutcome } from './synthesis.js';
import {
  MAX_DELEGATION_DEPTH,
  agentTaskQueue,
  type AgentActivities,
  type ControlActivities,
  type PrincipalSnapshot,
  type StepDispatch,
} from './types.js';

const control = proxyActivities<ControlActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

export async function TaskWorkflow(task: TaskRequest): Promise<TaskResult> {
  if (task.subject_token === undefined) {
    return fail(task, {
      class: 'permanent',
      message: 'task carries no subject_token — the gateway must forward the caller credential',
    });
  }

  // ADR-0007: the ONLY consumer of the subject token. From here on the
  // durable snapshot carries the principal's verified context.
  let snapshot: PrincipalSnapshot;
  try {
    snapshot = await control.snapshotPrincipal({
      subjectToken: task.subject_token,
      expectedPrincipal: task.principal,
      expectedTenant: task.tenant,
    });
  } catch (err) {
    return fail(task, { class: 'permanent', message: rootMessage(err) });
  }

  const { plan, planDigest } = await control.planTask(task);
  const steps: PlanStep[] = [...plan.steps];
  const total = steps.length;

  // The plan is on the audit stream BEFORE execution: auditors see intent,
  // not just outcomes.
  await control.emitAudit({
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    tenant: task.tenant,
    event_type: 'task.planned',
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: task.principal }, { sub: 'svc:orchestrator' }],
    },
    action: { name: 'task.planned', outputs_digest: planDigest },
    reason: { task_id: task.task_id },
    artifacts: { workflow_run_id: workflowInfo().runId },
    details: { plan, planner: plan.planner },
  });

  // Budget ledger: max_steps and max_tokens gate dispatch; max_cost_usd is
  // recorded, not enforced (pricing is Cost Meter scope). Gating happens at
  // dispatch — in-flight steps of a parallel wave complete and are kept, so
  // max_tokens can overshoot by in-flight usage.
  const ledger = {
    maxSteps: task.budget?.max_steps,
    maxTokens: task.budget?.max_tokens,
    stepsDispatched: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const tokensUsed = (): number => ledger.inputTokens + ledger.outputTokens;

  const results = new Map<string, StepResult>();
  const skipped = new Map<string, string>();
  let budgetStop: string | undefined;

  const emitSkipped = async (step: PlanStep, gap: string): Promise<void> => {
    skipped.set(step.step_id, gap);
    await control.emitAudit({
      event_id: uuid4(),
      occurred_at: new Date().toISOString(),
      tenant: task.tenant,
      event_type: 'step.skipped',
      actor: {
        principal: 'svc:orchestrator',
        delegation_chain: [{ sub: task.principal }, { sub: 'svc:orchestrator' }],
      },
      action: { name: 'step.skipped' },
      reason: {
        task_id: task.task_id,
        step_id: step.step_id,
        plan_step: planStepLabel(step, steps),
      },
      artifacts: { workflow_run_id: workflowInfo().runId },
      details: { capability: step.capability, gap },
    });
  };

  for (;;) {
    // 1) Dependency skips, to fixpoint: a failed or skipped dependency
    // skips the dependents — recorded as gaps, never a plan retry.
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) {
        if (results.has(step.step_id) || skipped.has(step.step_id)) continue;
        const badDep = (step.depends_on ?? []).find(
          (d) => skipped.has(d) || (results.has(d) && results.get(d)?.status !== 'completed'),
        );
        if (badDep === undefined) continue;
        const depCapability = steps.find((s) => s.step_id === badDep)?.capability ?? badDep;
        const why = skipped.has(badDep) ? 'was skipped' : 'failed';
        await emitSkipped(
          step,
          `${step.capability}: skipped — depends on ${depCapability}, which ${why}`,
        );
        changed = true;
      }
    }

    // 2) Ready steps, in plan order.
    const ready = steps.filter(
      (s) =>
        !results.has(s.step_id) &&
        !skipped.has(s.step_id) &&
        (s.depends_on ?? []).every((d) => results.get(d)?.status === 'completed'),
    );
    if (ready.length === 0) break;

    // 3) Budget gate BEFORE dispatching each ready step, in plan order.
    const wave: PlanStep[] = [];
    for (const step of ready) {
      const dispatched = ledger.stepsDispatched + wave.length;
      const reason =
        ledger.maxSteps !== undefined && dispatched >= ledger.maxSteps
          ? `max_steps ${ledger.maxSteps} reached`
          : ledger.maxTokens !== undefined && tokensUsed() >= ledger.maxTokens
            ? `max_tokens ${ledger.maxTokens} reached`
            : undefined;
      if (reason === undefined) {
        wave.push(step);
        continue;
      }
      // Exhaustion is a clean, reportable outcome: this step and every
      // remaining unstarted step become gaps.
      budgetStop = `budget exhausted after step ${dispatched} of ${total}: ${reason}`;
      for (const s of steps) {
        if (results.has(s.step_id) || skipped.has(s.step_id)) continue;
        if (wave.some((w) => w.step_id === s.step_id)) continue;
        await emitSkipped(s, `${budgetStop} — ${s.capability} not executed`);
      }
      break;
    }

    // 4) Dispatch the wave in parallel; every step carries the REMAINING
    // budget, not the whole task budget.
    if (wave.length > 0) {
      const remaining = remainingBudget(task.budget, tokensUsed());
      ledger.stepsDispatched += wave.length;
      const waveResults = await Promise.all(
        wave.map((step) =>
          runStep({
            taskId: task.task_id,
            tenant: task.tenant,
            principal: task.principal,
            snapshot,
            planStep: step,
            planRef: {
              planId: plan.plan_id,
              index: steps.findIndex((s) => s.step_id === step.step_id),
              total,
            },
            depth: 1,
            ...(remaining === undefined ? {} : { budget: remaining }),
          }),
        ),
      );
      for (const result of waveResults) {
        results.set(result.step_id, result);
        ledger.inputTokens += result.usage?.input_tokens ?? 0;
        ledger.outputTokens += result.usage?.output_tokens ?? 0;
      }
    }
    if (budgetStop !== undefined) break;
  }

  const outcomes: StepOutcome[] = steps.map((step) => {
    const result = results.get(step.step_id);
    const skipReason = skipped.get(step.step_id);
    return {
      planStep: step,
      ...(result === undefined ? {} : { result }),
      ...(skipReason === undefined ? {} : { skipReason }),
    };
  });
  const synthesized = synthesizeAnswer(outcomes);
  const error: CapabilityError | undefined =
    budgetStop !== undefined
      ? { class: 'budget_exhausted', message: budgetStop }
      : synthesized.error;

  const result: TaskResult = {
    kind: 'task_result',
    task_id: task.task_id,
    tenant: task.tenant,
    status: synthesized.status,
    ...(synthesized.answer !== undefined ? { answer: synthesized.answer } : {}),
    ...(synthesized.gaps.length > 0 ? { gaps: synthesized.gaps } : {}),
    ...(error !== undefined ? { error } : {}),
    plan,
    workflow_run_id: workflowInfo().runId,
    completed_at: new Date().toISOString(),
  };

  await control.emitAudit({
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    tenant: task.tenant,
    event_type: 'task.completed',
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: task.principal }, { sub: 'svc:orchestrator' }],
    },
    action: { name: 'task.completed' },
    reason: { task_id: task.task_id },
    artifacts: { workflow_run_id: workflowInfo().runId },
    details: {
      status: result.status,
      gaps: synthesized.gaps,
      steps: steps.map((s) => ({
        step_id: s.step_id,
        capability: s.capability,
        status: results.get(s.step_id)?.status ?? 'skipped',
      })),
      usage_totals: { input_tokens: ledger.inputTokens, output_tokens: ledger.outputTokens },
      budget: task.budget ?? null,
    },
  });

  return result;
}

/** Joins a child step; NEVER throws — a failed branch is a gap, not a dead task. */
async function runStep(dispatch: StepDispatch): Promise<StepResult> {
  try {
    return await executeChild(AgentStepWorkflow, {
      args: [dispatch],
      workflowId: `${workflowInfo().workflowId}-step-${dispatch.planStep.step_id}`,
    });
  } catch (err) {
    return {
      kind: 'step_result',
      step_id: dispatch.planStep.step_id,
      task_id: dispatch.taskId,
      tenant: dispatch.tenant,
      status: 'failed',
      error: {
        class: applicationFailureType(err) === 'Retryable' ? 'retryable' : 'permanent',
        message: rootMessage(err),
      },
    };
  }
}

export async function AgentStepWorkflow(dispatch: StepDispatch): Promise<StepResult> {
  const { planStep, snapshot } = dispatch;
  const failed = (error: NonNullable<StepResult['error']>): StepResult => ({
    kind: 'step_result',
    step_id: planStep.step_id,
    task_id: dispatch.taskId,
    tenant: dispatch.tenant,
    status: 'failed',
    error,
  });

  // Depth guard FIRST: enforcement precedes discovery and minting.
  if (dispatch.depth > MAX_DELEGATION_DEPTH) {
    return failed({
      class: 'permanent',
      message:
        `delegation depth ${dispatch.depth} exceeds the platform cap ${MAX_DELEGATION_DEPTH} — ` +
        'flatten the plan (agent-patterns.md); this is a planning failure, not a retry',
    });
  }

  // Dispatch-time discovery: a suspended agent is not `active` in the
  // registry, so the kill switch keeps stopping traffic per step — even for
  // steps planned hours ago.
  const card = await control.discoverAgent(planStep.capability, dispatch.tenant);
  if (card === null) {
    return failed({
      class: 'permanent',
      message:
        `no active agent serves capability ${planStep.capability} in tenant ${dispatch.tenant} — ` +
        'the agent may be suspended or not yet promoted (check the registry)',
    });
  }
  if (planStep.agent_id !== undefined && planStep.agent_id !== card.manifest.id) {
    return failed({
      class: 'permanent',
      message:
        `plan pinned agent ${planStep.agent_id} but discovery returned ${card.manifest.id} — ` +
        'the pinned agent is not active',
    });
  }

  const declared = card.manifest.capabilities.find((c) => c.name === planStep.capability);
  if (declared === undefined) {
    throw ApplicationFailure.nonRetryable(
      `agent ${card.manifest.id} does not declare capability ${planStep.capability}`,
    );
  }

  // Scopes the delegation may carry: the target's manifest bindings. The
  // token service intersects these with what the snapshot holds —
  // delegation narrows, never widens.
  const requestedScopes = (card.manifest.tools ?? []).flatMap((t) => t.scopes);

  const decision = await control.authorizeDelegation({
    principal: dispatch.principal,
    tenant: dispatch.tenant,
    agent: card,
    capability: planStep.capability,
    snapshot,
    requestedScopes,
    taskId: dispatch.taskId,
    stepId: planStep.step_id,
  });
  if (decision.decision !== 'allow') {
    return failed({
      class: 'policy_denied',
      message:
        `policy denied delegation of ${planStep.capability} to ${card.manifest.id} ` +
        `(bundle ${decision.bundle_version}) — the principal's scopes or the capability's ` +
        'risk class do not satisfy any permit',
    });
  }

  // Minted per step at dispatch — the ADR-0007 payoff: a step running at
  // t+3h carries a token as fresh as one minted at t+3s.
  const { token } = await control.brokerToken({
    snapshot,
    agent: card,
    scopes: requestedScopes,
    taskId: dispatch.taskId,
  });

  const request: StepRequest = {
    kind: 'step_request',
    step_id: planStep.step_id,
    task_id: dispatch.taskId,
    tenant: dispatch.tenant,
    agent_id: card.manifest.id,
    agent_version: card.version,
    capability: planStep.capability,
    input: planStep.input,
    delegation_depth: dispatch.depth,
    delegated_token: token,
    ...(dispatch.budget !== undefined ? { budget: dispatch.budget } : {}),
  };

  await control.emitAudit(
    stepAudit(dispatch, 'step.dispatched', card, {
      capability: planStep.capability,
      policy: decision,
    }),
  );

  const agent = proxyActivities<AgentActivities>({
    taskQueue: agentTaskQueue(card.manifest.id),
    startToCloseTimeout: `${(declared.sla?.p95_latency_s ?? card.manifest.sla?.p95_latency_s ?? 30) * 2} seconds`,
    retry: {
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'BudgetExhausted', 'NeedsInput', 'Permanent'],
    },
  });

  const result = await agent.execute_capability(request);

  await control.emitAudit(
    stepAudit(dispatch, 'step.completed', card, {
      capability: planStep.capability,
      status: result.status,
      usage: result.usage ?? null,
    }),
  );
  return result;
}

function fail(task: TaskRequest, error: NonNullable<TaskResult['error']>): TaskResult {
  return {
    kind: 'task_result',
    task_id: task.task_id,
    tenant: task.tenant,
    status: 'failed',
    error,
    workflow_run_id: workflowInfo().runId,
    completed_at: new Date().toISOString(),
  };
}

function remainingBudget(budget: Budget | undefined, tokensUsed: number): Budget | undefined {
  if (budget === undefined) return undefined;
  const remaining: Budget = {
    ...(budget.max_tokens === undefined ? {} : { max_tokens: budget.max_tokens - tokensUsed }),
    ...(budget.max_cost_usd === undefined ? {} : { max_cost_usd: budget.max_cost_usd }),
  };
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

const planStepLabel = (step: PlanStep, steps: PlanStep[]): string =>
  `${steps.findIndex((s) => s.step_id === step.step_id) + 1}/${steps.length}: ${step.rationale ?? step.capability}`;

function stepAudit(
  dispatch: StepDispatch,
  eventType: 'step.dispatched' | 'step.completed',
  card: AgentCard,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    tenant: dispatch.tenant,
    event_type: eventType,
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: dispatch.principal }, { sub: 'svc:orchestrator' }],
    },
    action: { name: eventType },
    reason: {
      task_id: dispatch.taskId,
      step_id: dispatch.planStep.step_id,
      plan_step: `${dispatch.planRef.index + 1}/${dispatch.planRef.total}: ${dispatch.planStep.rationale ?? dispatch.planStep.capability}`,
    },
    artifacts: {
      agent_id: card.manifest.id,
      agent_version: card.version,
      workflow_run_id: workflowInfo().runId,
    },
    details,
  };
}

/** The deepest cause message — Temporal wraps activity/child failures in generic envelopes. */
function rootMessage(err: unknown): string {
  let current: unknown = err;
  let message = err instanceof Error ? err.message : String(err);
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}

/** The innermost ApplicationFailure type in a failure chain, if any. */
function applicationFailureType(err: unknown): string | undefined {
  let type: string | undefined;
  let current: unknown = err;
  while (current instanceof Error) {
    if (current instanceof ApplicationFailure && typeof current.type === 'string') {
      type = current.type;
    }
    current = current.cause;
  }
  return type;
}
