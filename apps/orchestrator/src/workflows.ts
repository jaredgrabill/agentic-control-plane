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
  CancellationScope,
  ParentClosePolicy,
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler,
  startChild,
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
// The PURE pricing subpath only — never the node loader. Workflow code runs
// in the deterministic isolate; importing `@acp/cost-meter` (fs) here would
// be caught by the bundleWorkflowCode test.
import { priceUsageMicros, type ResolvedPriceBook } from '@acp/cost-meter/pricing';
import { synthesizeAnswer, type StepOutcome } from './synthesis.js';
import {
  APPROVAL_DENY_AFTER_S,
  APPROVAL_ESCALATE_AFTER_S,
  MAX_DELEGATION_DEPTH,
  agentTaskQueue,
  type AgentActivities,
  type ApprovalDecisionSignal,
  type ApprovalGateInput,
  type ApprovalOutcome,
  type ApprovalSubject,
  type ApprovalTokenGrounds,
  type CompensationEntry,
  type CompensationTokenGrounds,
  type ControlActivities,
  type ExecutedWrite,
  type PrincipalSnapshot,
  type RouteResult,
  type ShadowStepInput,
  type StepDispatch,
  type StepExecution,
} from './types.js';

/** Risk classes whose completed writes are candidates for the compensation stack. */
const WRITE_RISKS = new Set(['R2', 'R3']);

const control = proxyActivities<ControlActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

export async function TaskWorkflow(task: TaskRequest): Promise<TaskResult> {
  // Cancellation: the task body runs NON-cancellable so a cancel (or a
  // kill-switch-driven cancel) never tears the workflow down mid-write.
  // Instead the root scope's cancelRequested sets a flag and cancels ONLY the
  // current wave's explicit (cancellable) scope, so pre-dispatch phases
  // (discovery, policy, approval wait, broker) abort promptly while a shielded
  // execute_capability finishes. The body then drains the wave, unwinds any
  // completed writes, and returns an honest `cancelled` report via
  // handle.result() (NOT CancelledFailure — an auditor must retrieve it).
  let cancellationRequested = false;
  let waveScope: CancellationScope | undefined;
  CancellationScope.current().cancelRequested.catch(() => {
    cancellationRequested = true;
    waveScope?.cancel();
  });

  return CancellationScope.nonCancellable((): Promise<TaskResult> =>
    runTaskBody(
      task,
      () => cancellationRequested,
      (scope) => {
        waveScope = scope;
      },
    ),
  );
}

async function runTaskBody(
  task: TaskRequest,
  isCancelled: () => boolean,
  setWaveScope: (scope: CancellationScope | undefined) => void,
): Promise<TaskResult> {
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

  // Cost Meter: resolve the current price book once, pin its version for the
  // whole task. If the book can't be loaded, fail CLOSED when max_cost_usd is
  // set (the budget cannot be honored) and otherwise proceed with cost
  // recording disabled — a pricing outage must never silently drop an
  // enforced budget, nor block a task that had none.
  let book: ResolvedPriceBook | undefined;
  try {
    book = await control.getPriceBook();
  } catch {
    if (task.budget?.max_cost_usd !== undefined) {
      return fail(task, {
        class: 'retryable',
        message:
          'price book unavailable — max_cost_usd cannot be enforced; task rejected fail-closed',
      });
    }
    book = undefined;
  }

  // Budget ledger: max_steps, max_tokens, and max_cost_usd gate dispatch.
  // Gating happens at dispatch — in-flight steps of a parallel wave complete
  // and are kept, so any budget can overshoot by in-flight usage (honest
  // overshoot). max_cost_usd is enforced only when the book is available;
  // maxCostMicros is undefined otherwise (recording disabled). Ceiling the
  // budget to micros guarantees any positive budget is ≥ 1 micro, so the
  // first step always dispatches.
  const maxCostMicros =
    book !== undefined && task.budget?.max_cost_usd !== undefined
      ? Math.ceil(task.budget.max_cost_usd * 1_000_000)
      : undefined;
  const ledger = {
    maxSteps: task.budget?.max_steps,
    maxTokens: task.budget?.max_tokens,
    maxCostMicros,
    stepsDispatched: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
  };
  const tokensUsed = (): number => ledger.inputTokens + ledger.outputTokens;
  // Per-step cost in micros (for the audit) and whether any step was priced
  // on the fallback rates (unknown/absent model).
  const stepCosts = new Map<string, number>();
  let anyFallbackPriced = false;

  const results = new Map<string, StepResult>();
  const skipped = new Map<string, string>();
  let budgetStop: string | undefined;

  // Saga compensation stack: completed R2/R3 writes with a declared
  // compensator, pushed in wave order (deterministic under replay) and unwound
  // LIFO on failure/cancellation. Irreversible completed writes are recorded
  // separately for honest reporting — they are never dispatched.
  const compensationStack: CompensationEntry[] = [];
  const irreversibleWrites: { step_id: string; capability: string }[] = [];
  const stepNumberOf = (stepId: string): number => steps.findIndex((s) => s.step_id === stepId) + 1;

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
    // A cancellation between waves stops dispatch immediately: no new wave
    // starts, the remaining steps are marked cancelled below, and the unwind
    // runs.
    if (isCancelled()) break;

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
            : ledger.maxCostMicros !== undefined && ledger.costMicros >= ledger.maxCostMicros
              ? `max_cost_usd ${task.budget?.max_cost_usd} reached`
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
      const remaining = remainingBudget(
        task.budget,
        tokensUsed(),
        ledger.costMicros,
        ledger.maxCostMicros,
      );
      ledger.stepsDispatched += wave.length;
      // The wave runs in an explicit CANCELLABLE scope so a task cancel aborts
      // its in-flight pre-dispatch phases (the shielded execute_capability
      // still finishes). The scope reference is handed to the root
      // cancelRequested handler; the surrounding body stays non-cancellable.
      const waveResults = await CancellationScope.cancellable(
        async (): Promise<StepExecution[]> => {
          setWaveScope(CancellationScope.current());
          try {
            return await Promise.all(
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
                  plan,
                  planDigest,
                  ...(remaining === undefined ? {} : { budget: remaining }),
                }),
              ),
            );
          } finally {
            setWaveScope(undefined);
          }
        },
      );
      // Tally + push in WAVE order (deterministic under replay).
      for (let i = 0; i < wave.length; i += 1) {
        const step = wave[i];
        const execution = waveResults[i];
        if (step === undefined || execution === undefined) continue;
        const { result, executed } = execution;
        results.set(result.step_id, result);
        ledger.inputTokens += result.usage?.input_tokens ?? 0;
        ledger.outputTokens += result.usage?.output_tokens ?? 0;
        // Tally after Promise.all so overshoot is honest by construction: a
        // whole parallel wave is priced only once every step has completed.
        if (book !== undefined) {
          const { micros, fallbackUsed } = priceUsageMicros(result.usage, book);
          ledger.costMicros += micros;
          stepCosts.set(result.step_id, micros);
          if (fallbackUsed) anyFallbackPriced = true;
        }
        // Compensation stack: only a COMPLETED R2/R3 write with a declared
        // compensator is pushed (a failed write's side-effect state is unknown
        // — not compensated v1). An irreversible completed write is recorded
        // separately for honest reporting; it is never dispatched.
        if (
          result.status === 'completed' &&
          executed !== undefined &&
          WRITE_RISKS.has(executed.risk)
        ) {
          if (executed.compensator !== undefined) {
            compensationStack.push({
              originalStepId: step.step_id,
              originalCapability: step.capability,
              compensator: executed.compensator,
              agentId: executed.agentId,
              agentVersion: executed.agentVersion,
              input: step.input,
              ...(result.output === undefined ? {} : { output: result.output }),
              ...(executed.approval === undefined ? {} : { approval: executed.approval }),
            });
          } else if (executed.irreversible === true) {
            irreversibleWrites.push({ step_id: step.step_id, capability: step.capability });
          }
        }
      }
    }
    if (budgetStop !== undefined) break;
    if (isCancelled()) break;
  }

  // On cancellation, every step that never started (or is still unresolved) is
  // an honest gap before we unwind what DID complete.
  if (isCancelled()) {
    for (const s of steps) {
      if (results.has(s.step_id) || skipped.has(s.step_id)) continue;
      await emitSkipped(s, `task cancelled — ${s.capability} not executed`);
    }
  }

  // --- Saga unwind ------------------------------------------------------
  // All-or-nothing for change plans: unwind iff a trigger fired AND there are
  // completed writes to compensate. A plan whose every step completed and was
  // not cancelled keeps its writes (the fast path — zero compensation events).
  const allCompleted = steps.every((s) => results.get(s.step_id)?.status === 'completed');
  const trigger: 'cancellation' | 'budget_exhausted' | 'step_failure' | undefined = isCancelled()
    ? 'cancellation'
    : budgetStop !== undefined
      ? 'budget_exhausted'
      : !allCompleted
        ? 'step_failure'
        : undefined;

  const extraGaps: string[] = [];
  let compensationReport: NonNullable<TaskResult['compensation']> | undefined;

  if (trigger !== undefined && (compensationStack.length > 0 || irreversibleWrites.length > 0)) {
    const compensated: {
      original_step_id: string;
      original_capability: string;
      compensator: string;
    }[] = [];
    const failedComps: {
      original_step_id: string;
      original_capability: string;
      compensator: string;
      error: string;
    }[] = [];

    if (compensationStack.length > 0) {
      // Unwind order is the reverse of the push order (LIFO): the last write
      // is compensated first. Deterministic under replay.
      const unwindOrder = [...compensationStack].reverse();
      await control.emitAudit(
        compensationAudit(task, 'compensation.started', {
          trigger,
          stack_depth: unwindOrder.length,
          entries: unwindOrder.map((e) => ({
            original_step_id: e.originalStepId,
            original_capability: e.originalCapability,
            compensator: e.compensator,
          })),
        }),
      );

      for (const entry of unwindOrder) {
        const n = stepNumberOf(entry.originalStepId);
        // Synthetic compensator step. Input is derived MECHANICALLY from the
        // recorded write (never attacker-supplied): {original: {…}}. New uuid
        // step_id, depth 1, NO budget (cleanup is a safety obligation; budget
        // exhaustion may be the very trigger; usage is still tallied).
        const compStep: PlanStep = {
          step_id: uuid4(),
          capability: entry.compensator,
          input: {
            original: {
              step_id: entry.originalStepId,
              capability: entry.originalCapability,
              input: entry.input,
              ...(entry.output === undefined ? {} : { output: entry.output }),
            },
          },
          rationale: `compensation for ${entry.originalCapability} (step ${n})`,
        };
        const { result } = await runStep({
          taskId: task.task_id,
          tenant: task.tenant,
          principal: task.principal,
          snapshot,
          planStep: compStep,
          planRef: { planId: plan.plan_id, index: n - 1, total },
          depth: 1,
          plan,
          planDigest,
          compensation: {
            originalStepId: entry.originalStepId,
            originalCapability: entry.originalCapability,
            // Pin the compensator to the version that did the write (D5).
            agentId: entry.agentId,
            agentVersion: entry.agentVersion,
            ...(entry.approval === undefined ? {} : { approval: entry.approval }),
          },
        });
        // Tally compensation usage into the totals (no budget gate, but the
        // spend is real and must be reported).
        ledger.inputTokens += result.usage?.input_tokens ?? 0;
        ledger.outputTokens += result.usage?.output_tokens ?? 0;
        if (book !== undefined) {
          ledger.costMicros += priceUsageMicros(result.usage, book).micros;
        }
        const record = {
          original_step_id: entry.originalStepId,
          original_capability: entry.originalCapability,
          compensator: entry.compensator,
        };
        if (result.status === 'completed') {
          compensated.push(record);
        } else {
          // Compensator failure is first-class and loudly audited; keep
          // unwinding the rest (entries are independent — aborting strands them).
          const errMsg = result.error?.message ?? 'compensator failed';
          const effect =
            `compensation incomplete: ${entry.originalCapability} (step ${n}) remains in effect — ` +
            `${entry.compensator} failed: ${errMsg}`;
          failedComps.push({ ...record, error: errMsg });
          extraGaps.push(effect);
          await control.emitAudit(
            compensationAudit(
              task,
              'compensation.step_failed',
              { ...record, effect, error: errMsg },
              entry.originalStepId,
            ),
          );
        }
      }
    }

    // Irreversible completed writes are never dispatched — reported honestly.
    for (const irr of irreversibleWrites) {
      extraGaps.push(
        `compensation: ${irr.capability} (step ${stepNumberOf(irr.step_id)}) is irreversible — ` +
          `the write was not undone`,
      );
    }

    compensationReport = {
      status: failedComps.length > 0 ? 'incomplete' : 'complete',
      trigger,
      compensated,
      failed: failedComps,
      irreversible: irreversibleWrites,
    };

    if (compensationStack.length > 0) {
      await control.emitAudit(
        compensationAudit(task, 'compensation.completed', {
          status: compensationReport.status,
          trigger,
          compensated,
          failed: failedComps,
          irreversible: irreversibleWrites,
        }),
      );
    }
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
  // A cancelled task reports status `cancelled` and carries no top-level error
  // (the gaps and compensation block explain what happened). Otherwise the
  // budget-exhausted / synthesized error stands.
  const cancelled = isCancelled();
  const status: TaskResult['status'] = cancelled ? 'cancelled' : synthesized.status;
  const error: CapabilityError | undefined = cancelled
    ? undefined
    : budgetStop !== undefined
      ? { class: 'budget_exhausted', message: budgetStop }
      : synthesized.error;
  const gaps = [...synthesized.gaps, ...extraGaps];

  const result: TaskResult = {
    kind: 'task_result',
    task_id: task.task_id,
    tenant: task.tenant,
    status,
    ...(synthesized.answer !== undefined ? { answer: synthesized.answer } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    ...(error !== undefined ? { error } : {}),
    plan,
    ...(compensationReport !== undefined ? { compensation: compensationReport } : {}),
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
      gaps,
      steps: steps.map((s) => ({
        step_id: s.step_id,
        capability: s.capability,
        status: results.get(s.step_id)?.status ?? 'skipped',
        // Per-step cost in USD, present only for steps priced under a book.
        ...(stepCosts.has(s.step_id)
          ? { cost_usd: (stepCosts.get(s.step_id) ?? 0) / 1_000_000 }
          : {}),
      })),
      usage_totals: {
        input_tokens: ledger.inputTokens,
        output_tokens: ledger.outputTokens,
        // Total task cost in USD, or null when pricing was disabled (no book).
        cost_usd: book !== undefined ? ledger.costMicros / 1_000_000 : null,
      },
      // The exact book version this cost was computed against — reproducible.
      price_book_version: book?.version ?? null,
      ...(anyFallbackPriced ? { cost_fallback_priced: true } : {}),
      budget: task.budget ?? null,
      ...(cancelled ? { cancelled: true } : {}),
      ...(compensationReport !== undefined ? { compensation: compensationReport } : {}),
    },
  });

  return result;
}

/** Builds a compensation-lifecycle audit event (actor = orchestrator). */
function compensationAudit(
  task: TaskRequest,
  eventType: 'compensation.started' | 'compensation.step_failed' | 'compensation.completed',
  details: Record<string, unknown>,
  stepId?: string,
): Record<string, unknown> {
  return {
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    tenant: task.tenant,
    event_type: eventType,
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: task.principal }, { sub: 'svc:orchestrator' }],
    },
    action: { name: eventType },
    reason: { task_id: task.task_id, ...(stepId === undefined ? {} : { step_id: stepId }) },
    artifacts: { workflow_run_id: workflowInfo().runId },
    details,
  };
}

/** Joins a child step; NEVER throws — a failed branch is a gap, not a dead task. */
async function runStep(dispatch: StepDispatch): Promise<StepExecution> {
  // A compensator's child gets a distinct, deterministic id keyed on the
  // ORIGINAL step it reverses; a normal step keys on its own step_id.
  const workflowId =
    dispatch.compensation === undefined
      ? `${workflowInfo().workflowId}-step-${dispatch.planStep.step_id}`
      : `${workflowInfo().workflowId}-comp-${dispatch.compensation.originalStepId}`;
  try {
    return await executeChild(AgentStepWorkflow, { args: [dispatch], workflowId });
  } catch (err) {
    // Even a child that fails with CancelledFailure (or any envelope) becomes a
    // typed failed result here — a failed branch is a gap, not a dead task.
    const message = isCancellation(err) ? 'task cancelled — step not executed' : rootMessage(err);
    return {
      result: {
        kind: 'step_result',
        step_id: dispatch.planStep.step_id,
        task_id: dispatch.taskId,
        tenant: dispatch.tenant,
        status: 'failed',
        error: {
          class: applicationFailureType(err) === 'Retryable' ? 'retryable' : 'permanent',
          message,
        },
      },
    };
  }
}

export async function AgentStepWorkflow(dispatch: StepDispatch): Promise<StepExecution> {
  const { planStep } = dispatch;
  const failed = (error: NonNullable<StepResult['error']>): StepExecution => ({
    result: {
      kind: 'step_result',
      step_id: planStep.step_id,
      task_id: dispatch.taskId,
      tenant: dispatch.tenant,
      status: 'failed',
      error,
    },
  });
  const isCompensation = dispatch.compensation !== undefined;

  try {
    return await runAgentStep(dispatch, failed, isCompensation);
  } catch (err) {
    // Pre-dispatch phases (discovery, policy, approval wait, broker) are
    // freely cancellable: a task cancel here means nothing executed, so the
    // step is an honest not-executed failure and there is nothing to
    // compensate. The dangerous execute_capability phase is shielded below and
    // never reaches this catch by cancellation.
    if (isCancellation(err)) {
      return failed({ class: 'permanent', message: 'task cancelled — step not executed' });
    }
    throw err;
  }
}

async function runAgentStep(
  dispatch: StepDispatch,
  failed: (error: NonNullable<StepResult['error']>) => StepExecution,
  isCompensation: boolean,
): Promise<StepExecution> {
  const { planStep, snapshot } = dispatch;

  // Depth guard FIRST: enforcement precedes discovery and minting.
  if (dispatch.depth > MAX_DELEGATION_DEPTH) {
    return failed({
      class: 'permanent',
      message:
        `delegation depth ${dispatch.depth} exceeds the platform cap ${MAX_DELEGATION_DEPTH} — ` +
        'flatten the plan (agent-patterns.md); this is a planning failure, not a retry',
    });
  }

  // Dispatch-time version-aware routing (D5): resolveRoute reads the registry
  // routing set, computes the deterministic session bucket, and returns the
  // card to run plus any shadow candidate to mirror. A suspended agent is not
  // `active`, so the kill switch keeps stopping traffic per step. A compensator
  // is PINNED to the version that did the write and is never mirrored.
  const route = await control.resolveRoute({
    capability: planStep.capability,
    tenant: dispatch.tenant,
    taskId: dispatch.taskId,
    ...(dispatch.compensation === undefined
      ? {}
      : {
          pin: {
            agentId: dispatch.compensation.agentId,
            version: dispatch.compensation.agentVersion,
          },
        }),
  });
  if (route === null) {
    return failed({
      class: 'permanent',
      message:
        `no active agent serves capability ${planStep.capability} in tenant ${dispatch.tenant} — ` +
        'the agent may be suspended or not yet promoted (check the registry)',
    });
  }
  const card = route.card;
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
    // A compensator dispatch tags Cedar context so permit-compensation (not
    // the R2 gate) decides — the unwind is never re-suspended on approval.
    ...(dispatch.compensation === undefined
      ? {}
      : {
          compensation: {
            originalStepId: dispatch.compensation.originalStepId,
            originalCapability: dispatch.compensation.originalCapability,
          },
        }),
  });
  if (decision.decision === 'deny') {
    return failed({
      class: 'policy_denied',
      message:
        `policy denied delegation of ${planStep.capability} to ${card.manifest.id} ` +
        `(bundle ${decision.bundle_version}) — the principal's scopes or the capability's ` +
        'risk class do not satisfy any permit',
    });
  }

  // A require-approval verdict on a COMPENSATION dispatch is a policy bug:
  // compensators are pre-authorized by the write's original approval and must
  // never re-gate (a human gate on an unwind would strand a live write and
  // could deadlock an unattended failure). Fail closed as compensation-
  // incomplete — NEVER spawn an ApprovalWorkflow on this branch. This is the
  // structural guarantee that the compensation path has no executeChild(
  // ApprovalWorkflow).
  if (isCompensation && decision.decision === 'require-approval') {
    return failed({
      class: 'policy_denied',
      message:
        `compensation delegation of ${planStep.capability} to ${card.manifest.id} returned ` +
        'require-approval — compensators are pre-authorized by the original write’s approval ' +
        'and must not re-gate (policy misconfiguration); the write remains in effect',
    });
  }

  // Three-way: a require-approval decision SUSPENDS this step on a durable
  // ApprovalWorkflow child until a verified human decides (or it times out
  // and DENIES). The gate fires from the PDP verdict inside this workflow —
  // an agent can neither trigger nor skip it. Parallel siblings complete
  // independently; the wave's Promise.all simply waits for this one.
  let approvalGrounds: ApprovalTokenGrounds | undefined;
  if (decision.decision === 'require-approval') {
    const approvalId = uuid4();
    const subject: ApprovalSubject = {
      approval_id: approvalId,
      task_id: dispatch.taskId,
      step_id: planStep.step_id,
      tenant: dispatch.tenant,
      principal: dispatch.principal,
      agent_id: card.manifest.id,
      agent_version: card.version,
      capability: planStep.capability,
      risk: declared.risk,
      input: planStep.input,
      requested_scopes: requestedScopes,
      ...(declared.compensator === undefined ? {} : { compensator: declared.compensator }),
      ...(declared.irreversible === undefined ? {} : { irreversible: declared.irreversible }),
      plan: dispatch.plan,
      plan_digest: dispatch.planDigest,
    };
    // sha256 in an activity (no crypto in the isolate); the digest binds the
    // exact subject the approver sees to the decision and the eventual token.
    const { subject_digest } = await control.digestApprovalSubject(subject);

    const outcome: ApprovalOutcome = await executeChild(ApprovalWorkflow, {
      workflowId: `approval-${approvalId}`,
      args: [
        {
          subject,
          subject_digest,
          escalate_after_s: APPROVAL_ESCALATE_AFTER_S,
          deny_after_s: APPROVAL_DENY_AFTER_S,
        } satisfies ApprovalGateInput,
      ],
    });

    if (!outcome.granted) {
      // Denied or timed out → the step is NOT executed and the task reports it
      // as a gap (dependents skip). Nothing ran, so there is nothing to
      // compensate.
      return failed({
        class: 'policy_denied',
        message:
          `approval ${outcome.reason} for ${planStep.capability} on ${card.manifest.id} ` +
          `(approval ${approvalId}) — step not executed`,
      });
    }

    // Re-route after the wait: suspension DURING the approval window must
    // still stop traffic. If the agent is gone or its routed version moved,
    // the approval no longer applies to what would run — fail permanent.
    const current = (
      await control.resolveRoute({
        capability: planStep.capability,
        tenant: dispatch.tenant,
        taskId: dispatch.taskId,
      })
    )?.card;
    if (current?.manifest.id !== card.manifest.id || current.version !== card.version) {
      return failed({
        class: 'permanent',
        message:
          `agent ${card.manifest.id}@${card.version} serving ${planStep.capability} is no longer ` +
          'active after the approval wait — the granted approval does not apply to a changed agent',
      });
    }

    // A granted outcome always carries decision metadata; guard defensively so
    // the token grounds are never built from a partial outcome.
    if (outcome.decision_id === undefined || outcome.approver === undefined) {
      return failed({
        class: 'permanent',
        message: `approval ${approvalId} granted without decision metadata — refusing to broker`,
      });
    }
    approvalGrounds = {
      approval_id: approvalId,
      decision_id: outcome.decision_id,
      approver: outcome.approver,
      step_id: planStep.step_id,
      capability: planStep.capability,
      subject_digest,
    };
  }

  // Compensation grounds for a compensator's mint (mutually exclusive with
  // approval — the token service refuses both). Carries the original write's
  // approval id/approver when it was gated, joining the unwind to the decision.
  const compensationGrounds: CompensationTokenGrounds | undefined = dispatch.compensation
    ? {
        original_step_id: dispatch.compensation.originalStepId,
        original_capability: dispatch.compensation.originalCapability,
        ...(dispatch.compensation.approval?.approval_id === undefined
          ? {}
          : { approval_id: dispatch.compensation.approval.approval_id }),
        ...(dispatch.compensation.approval?.approver === undefined
          ? {}
          : { approver: dispatch.compensation.approval.approver }),
      }
    : undefined;

  // Minted per step at dispatch — the ADR-0007 payoff: a step running at
  // t+3h carries a token as fresh as one minted at t+3s. When the step passed
  // an approval gate, the mint carries the signed approval grounds; a
  // compensator's mint carries the signed compensation grounds instead.
  const { token } = await control.brokerToken({
    snapshot,
    agent: card,
    scopes: requestedScopes,
    taskId: dispatch.taskId,
    ...(approvalGrounds === undefined ? {} : { approval: approvalGrounds }),
    ...(compensationGrounds === undefined ? {} : { compensation: compensationGrounds }),
    // Capability grounds on EVERY mint: the executing capability and its
    // declared risk class, read by the tool gateway to enforce risk classes.
    // For a compensator dispatch `declared` is the compensator's own capability
    // (dispatch-time discovery), so it carries the compensator's true risk.
    capability: { name: planStep.capability, risk: declared.risk },
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

  const compensationDetails =
    dispatch.compensation === undefined
      ? {}
      : {
          compensation: {
            original_step_id: dispatch.compensation.originalStepId,
            original_capability: dispatch.compensation.originalCapability,
          },
        };

  // Routing details on step.dispatched — the canary gate folds route +
  // ramp_percent to split candidate vs incumbent samples (open details, no
  // schema change).
  await control.emitAudit(
    stepAudit(dispatch, 'step.dispatched', card, {
      capability: planStep.capability,
      policy: decision,
      route: route.route,
      ...(route.rampPercent === undefined ? {} : { ramp_percent: route.rampPercent }),
      ...(approvalGrounds === undefined ? {} : { approval_id: approvalGrounds.approval_id }),
      ...compensationDetails,
    }),
  );

  // Shadow mirroring (D6): during a shadow soak the primary runs the incumbent,
  // and a fire-and-forget ShadowStepWorkflow runs the SAME step against the
  // candidate. ABANDON parent-close policy + never awaited: shadow latency or
  // failure can NEVER touch production, and shadow usage never lands in the
  // ledger/budget. Compensators pin and never mirror (route.shadowCard absent).
  if (route.shadowCard !== undefined) {
    await startChild(ShadowStepWorkflow, {
      workflowId: `${workflowInfo().workflowId}-shadow-${planStep.step_id}`,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [
        {
          taskId: dispatch.taskId,
          stepId: planStep.step_id,
          tenant: dispatch.tenant,
          principal: dispatch.principal,
          snapshot,
          capability: planStep.capability,
          input: planStep.input,
          shadowCard: route.shadowCard,
          incumbentVersion: card.version,
        } satisfies ShadowStepInput,
      ],
    });
  }

  const agent = proxyActivities<AgentActivities>({
    taskQueue: agentTaskQueue(card.manifest.id, card.version),
    startToCloseTimeout: `${(declared.sla?.p95_latency_s ?? card.manifest.sla?.p95_latency_s ?? 30) * 2} seconds`,
    retry: {
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'BudgetExhausted', 'NeedsInput', 'Permanent'],
    },
  });

  // SHIELD: execute_capability and its step.completed audit run inside a
  // non-cancellable scope. A task cancel that arrives mid-write lets the write
  // finish and be recorded — so the parent KNOWS the write happened and can
  // unwind it ("we did X and undid it") rather than leaving unknown state.
  const result = await CancellationScope.nonCancellable(async (): Promise<StepResult> => {
    // duration_ms is the workflow-clock delta around execute_capability — the
    // canary gate's p95 latency signal (open details, no schema change).
    const startedMs = Date.now();
    const stepResult = await agent.execute_capability(request);
    const durationMs = Date.now() - startedMs;
    await control.emitAudit(
      stepAudit(dispatch, 'step.completed', card, {
        capability: planStep.capability,
        status: stepResult.status,
        usage: stepResult.usage ?? null,
        duration_ms: durationMs,
        ...compensationDetails,
      }),
    );
    return stepResult;
  });

  // Executed metadata — only the child knows the discovered capability's risk
  // and reversibility. The TaskWorkflow reads it to build the compensation
  // stack (completed R2/R3 with a compensator) or record an irreversible write.
  const executed: ExecutedWrite = {
    agentId: card.manifest.id,
    agentVersion: card.version,
    risk: declared.risk,
    ...(declared.compensator === undefined ? {} : { compensator: declared.compensator }),
    ...(declared.irreversible === undefined ? {} : { irreversible: declared.irreversible }),
    ...(approvalGrounds === undefined
      ? {}
      : {
          approval: {
            approval_id: approvalGrounds.approval_id,
            decision_id: approvalGrounds.decision_id,
            approver: approvalGrounds.approver,
            subject_digest: approvalGrounds.subject_digest,
          },
        }),
  };
  return { result, executed };
}

/**
 * Fire-and-forget mirror of one primary step against a shadow candidate (D6).
 * Started with ParentClosePolicy.ABANDON and NEVER awaited, so its latency or
 * failure can never touch production. It runs the SAME PEP (authorizeDelegation)
 * — a gated (require-approval) capability is NOT mirrored in v0, recorded and
 * skipped — mints a token carrying `deployment {mode:'shadow'}` (the tool
 * gateway suppresses its side effects), executes the candidate, and emits
 * `deployment.shadow_result` joined to the primary on (task_id, step_id). It
 * NEVER throws: every failure is caught and recorded as the shadow result, so
 * the abandoned child always closes cleanly.
 */
export async function ShadowStepWorkflow(input: ShadowStepInput): Promise<void> {
  const { shadowCard } = input;
  const declared = shadowCard.manifest.capabilities.find((c) => c.name === input.capability);

  const emitResult = async (
    status: 'completed' | 'failed' | 'skipped',
    extra: Record<string, unknown>,
  ): Promise<void> => {
    await control.emitAudit({
      event_id: uuid4(),
      occurred_at: new Date().toISOString(),
      // Task tenant — the shadow result is paired to the task's primary steps.
      tenant: input.tenant,
      event_type: 'deployment.shadow_result',
      actor: {
        principal: 'svc:orchestrator',
        delegation_chain: [{ sub: input.principal }, { sub: 'svc:orchestrator' }],
      },
      action: { name: 'deployment.shadow_result' },
      reason: { task_id: input.taskId, step_id: input.stepId },
      artifacts: {
        agent_id: shadowCard.manifest.id,
        agent_version: shadowCard.version,
        workflow_run_id: workflowInfo().runId,
      },
      details: { status, incumbent_version: input.incumbentVersion, ...extra },
    });
  };

  try {
    if (declared === undefined) {
      await emitResult('skipped', { reason: 'shadow candidate does not declare the capability' });
      return;
    }
    const requestedScopes = (shadowCard.manifest.tools ?? []).flatMap((t) => t.scopes);

    // Same PEP as the primary. v0 does not mirror a gated capability (a
    // require-approval verdict would need a human) — record and stop.
    const decision = await control.authorizeDelegation({
      principal: input.principal,
      tenant: input.tenant,
      agent: shadowCard,
      capability: input.capability,
      snapshot: input.snapshot,
      requestedScopes,
      taskId: input.taskId,
      stepId: input.stepId,
    });
    if (decision.decision !== 'allow') {
      await emitResult('skipped', {
        reason: `shadow not mirrored: policy verdict ${decision.decision} (v0 mirrors only allow)`,
      });
      return;
    }

    const { token } = await control.brokerToken({
      snapshot: input.snapshot,
      agent: shadowCard,
      scopes: requestedScopes,
      taskId: input.taskId,
      capability: { name: input.capability, risk: declared.risk },
      // The shadow claim — the tool gateway suppresses this step's side effects.
      deployment: { mode: 'shadow' },
    });

    const request: StepRequest = {
      kind: 'step_request',
      step_id: input.stepId,
      task_id: input.taskId,
      tenant: input.tenant,
      agent_id: shadowCard.manifest.id,
      agent_version: shadowCard.version,
      capability: input.capability,
      input: input.input,
      delegation_depth: 1,
      delegated_token: token,
    };

    const agent = proxyActivities<AgentActivities>({
      taskQueue: agentTaskQueue(shadowCard.manifest.id, shadowCard.version),
      // 2× the SLA — a slow shadow must not hang, but it gets room to complete.
      startToCloseTimeout: `${(declared.sla?.p95_latency_s ?? shadowCard.manifest.sla?.p95_latency_s ?? 30) * 2} seconds`,
      retry: { maximumAttempts: 1 },
    });

    const startedMs = Date.now();
    const result = await agent.execute_capability(request);
    const durationMs = Date.now() - startedMs;
    const { digest } = await control.digestValue(result.output ?? null);
    await emitResult(result.status === 'completed' ? 'completed' : 'failed', {
      output_digest: digest,
      usage: result.usage ?? null,
      duration_ms: durationMs,
      ...(result.error?.class === undefined ? {} : { error_class: result.error.class }),
    });
  } catch (err) {
    // A shadow failure is data, never an incident: record it and close cleanly.
    await emitResult('failed', { error_class: 'shadow_error', error: rootMessage(err) });
  }
}

/** Signal the gateway sends a verified human decision on. */
export const approvalDecisionSignal = defineSignal<[ApprovalDecisionSignal]>('approvalDecision');

/** Status query the gateway/CLI reads (source of truth; immune to audit lag). */
export interface ApprovalStatus {
  status: 'pending' | 'granted' | 'denied' | 'timeout';
  subject: ApprovalSubject;
  subject_digest: string;
  requested_at: string;
  escalated: boolean;
  rejected_signals: number;
}
export const approvalStatusQuery = defineQuery<ApprovalStatus>('approvalStatus');

/**
 * Durable human-approval gate (governance-and-policy: require-approval
 * suspends the workflow). Waits on a signal for up to deny_after_s, escalating
 * (notification only, NO authority change) at escalate_after_s. FIRST VALID
 * DECISION WINS; a timeout DENIES by default — no path returns granted without
 * an accepted signal. The digest is re-validated in the handler even though the
 * gateway pre-validates: defense in depth against raw Temporal signal access.
 */
export async function ApprovalWorkflow(input: ApprovalGateInput): Promise<ApprovalOutcome> {
  const { subject, subject_digest } = input;
  const requestedAt = new Date().toISOString();
  const startMs = Date.now();
  let decision: ApprovalDecisionSignal | undefined;
  let escalated = false;
  let rejectedSignals = 0;

  setHandler(approvalDecisionSignal, (signal) => {
    // Validate-and-enqueue only; first valid decision wins. Every rejection
    // is COUNTED (rubber-stamp / tampering signal) but never obeyed.
    if (decision !== undefined) {
      rejectedSignals += 1; // already decided
      return;
    }
    // Defensive against raw Temporal signal access: the value is typed but the
    // wire is not, so validate as a string.
    const kind: string = signal.decision;
    if (kind !== 'approve' && kind !== 'deny') {
      rejectedSignals += 1; // bad decision value
      return;
    }
    if (typeof signal.approver !== 'string' || signal.approver === '') {
      rejectedSignals += 1; // empty approver
      return;
    }
    if (signal.approver === subject.principal) {
      rejectedSignals += 1; // structural self-approval refusal
      return;
    }
    if (signal.subject_digest !== subject_digest) {
      rejectedSignals += 1; // stale/forged context
      return;
    }
    decision = signal;
  });

  setHandler(approvalStatusQuery, (): ApprovalStatus => ({
    status:
      decision === undefined ? 'pending' : decision.decision === 'approve' ? 'granted' : 'denied',
    subject,
    subject_digest,
    requested_at: requestedAt,
    escalated,
    rejected_signals: rejectedSignals,
  }));

  await emitApprovalAudit(subject, subject_digest, 'approval.requested', {
    approval_id: subject.approval_id,
    capability: subject.capability,
    risk: subject.risk,
    principal: subject.principal,
    requested_scopes: subject.requested_scopes,
    ...(subject.compensator === undefined ? {} : { compensator: subject.compensator }),
    ...(subject.irreversible === undefined ? {} : { irreversible: subject.irreversible }),
    input: subject.input,
    plan: subject.plan,
    plan_digest: subject.plan_digest,
    escalate_after_s: input.escalate_after_s,
    deny_after_s: input.deny_after_s,
  });

  const decidedInT1 = await condition(() => decision !== undefined, `${input.escalate_after_s}s`);
  if (!decidedInT1) {
    // Escalation is notification-only — it changes nothing about who may
    // decide or how long remains; the same deny_after_s deadline still holds.
    escalated = true;
    await emitApprovalAudit(subject, subject_digest, 'approval.escalated', {
      approval_id: subject.approval_id,
      escalate_after_s: input.escalate_after_s,
    });
    await condition(
      () => decision !== undefined,
      `${input.deny_after_s - input.escalate_after_s}s`,
    );
  }

  const latencyMs = Date.now() - startMs;

  if (decision === undefined) {
    // TIMEOUT → DENY. The only terminal path that returns without an accepted
    // signal, and it never grants.
    await emitApprovalAudit(subject, subject_digest, 'approval.timeout', {
      approval_id: subject.approval_id,
      deny_after_s: input.deny_after_s,
      escalated,
      rejected_signals: rejectedSignals,
      latency_ms: latencyMs,
    });
    return {
      granted: false,
      reason: 'timeout',
      approval_id: subject.approval_id,
      latency_ms: latencyMs,
      subject_digest,
    };
  }

  const granted = decision.decision === 'approve';
  await emitApprovalAudit(
    subject,
    subject_digest,
    granted ? 'approval.granted' : 'approval.denied',
    {
      approval_id: subject.approval_id,
      decision_id: decision.decision_id,
      latency_ms: latencyMs,
      // Rubber-stamp: a sub-second human decision is flagged for review.
      rubber_stamp: latencyMs < 1000,
      subject_digest,
      escalated,
      rejected_signals: rejectedSignals,
      ...(decision.note === undefined ? {} : { note: decision.note }),
    },
    // The APPROVER is the actor of a grant/deny — the chain they presented.
    { principal: decision.approver, chain: decision.approver_chain },
  );

  return {
    granted,
    reason: granted ? 'approved' : 'denied',
    approval_id: subject.approval_id,
    decision_id: decision.decision_id,
    approver: decision.approver,
    latency_ms: latencyMs,
    subject_digest,
  };
}

/**
 * Emits an approval-lifecycle audit event. Actor defaults to the orchestrator
 * (requested/escalated/timeout are platform-emitted); grant/deny pass the
 * approver as actor with the chain they presented.
 */
async function emitApprovalAudit(
  subject: ApprovalSubject,
  subjectDigest: string,
  eventType:
    | 'approval.requested'
    | 'approval.granted'
    | 'approval.denied'
    | 'approval.timeout'
    | 'approval.escalated',
  details: Record<string, unknown>,
  actor?: { principal: string; chain: { sub: string }[] },
): Promise<void> {
  await control.emitAudit({
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    tenant: subject.tenant,
    event_type: eventType,
    actor:
      actor === undefined
        ? {
            principal: 'svc:orchestrator',
            delegation_chain: [{ sub: subject.principal }, { sub: 'svc:orchestrator' }],
          }
        : { principal: actor.principal, delegation_chain: actor.chain },
    action: { name: eventType, inputs_digest: subjectDigest },
    reason: { task_id: subject.task_id, step_id: subject.step_id },
    artifacts: {
      agent_id: subject.agent_id,
      agent_version: subject.agent_version,
      workflow_run_id: workflowInfo().runId,
    },
    details,
  });
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

function remainingBudget(
  budget: Budget | undefined,
  tokensUsed: number,
  costMicrosUsed: number,
  maxCostMicros: number | undefined,
): Budget | undefined {
  if (budget === undefined) return undefined;
  // When the book priced the cost budget, forward the REMAINING dollars
  // (micro-exact). Computed only at dispatch, where the gate guarantees
  // costMicrosUsed < maxCostMicros — so the forwarded max_cost_usd is always
  // strictly positive (satisfying the budget schema). Book-less tasks with no
  // cost budget pass through exactly as before.
  const cost =
    maxCostMicros !== undefined
      ? { max_cost_usd: (maxCostMicros - costMicrosUsed) / 1_000_000 }
      : budget.max_cost_usd === undefined
        ? {}
        : { max_cost_usd: budget.max_cost_usd };
  const remaining: Budget = {
    ...(budget.max_tokens === undefined ? {} : { max_tokens: budget.max_tokens - tokensUsed }),
    ...cost,
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
