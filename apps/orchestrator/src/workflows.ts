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
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
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
            plan,
            planDigest,
            ...(remaining === undefined ? {} : { budget: remaining }),
          }),
        ),
      );
      for (const result of waveResults) {
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
  if (decision.decision === 'deny') {
    return failed({
      class: 'policy_denied',
      message:
        `policy denied delegation of ${planStep.capability} to ${card.manifest.id} ` +
        `(bundle ${decision.bundle_version}) — the principal's scopes or the capability's ` +
        'risk class do not satisfy any permit',
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

    // Re-discover after the wait: suspension DURING the approval window must
    // still stop traffic. If the agent is gone or its active version moved,
    // the approval no longer applies to what would run — fail permanent.
    const current = await control.discoverAgent(planStep.capability, dispatch.tenant);
    if (
      current === null ||
      current.manifest.id !== card.manifest.id ||
      current.version !== card.version
    ) {
      return failed({
        class: 'permanent',
        message:
          `agent ${card.manifest.id}@${card.version} serving ${planStep.capability} is no longer ` +
          'active after the approval wait — the granted approval does not apply to a changed agent',
      });
    }

    approvalGrounds = {
      approval_id: approvalId,
      decision_id: outcome.decision_id!,
      approver: outcome.approver!,
      step_id: planStep.step_id,
      capability: planStep.capability,
      subject_digest,
    };
  }

  // Minted per step at dispatch — the ADR-0007 payoff: a step running at
  // t+3h carries a token as fresh as one minted at t+3s. When the step passed
  // an approval gate, the mint carries the signed approval grounds; the token
  // service refuses self-approval before it signs the claim.
  const { token } = await control.brokerToken({
    snapshot,
    agent: card,
    scopes: requestedScopes,
    taskId: dispatch.taskId,
    ...(approvalGrounds === undefined ? {} : { approval: approvalGrounds }),
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
      ...(approvalGrounds === undefined ? {} : { approval_id: approvalGrounds.approval_id }),
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
    if (signal.decision !== 'approve' && signal.decision !== 'deny') {
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

  setHandler(
    approvalStatusQuery,
    (): ApprovalStatus => ({
      status:
        decision === undefined
          ? 'pending'
          : decision.decision === 'approve'
            ? 'granted'
            : 'denied',
      subject,
      subject_digest,
      requested_at: requestedAt,
      escalated,
      rejected_signals: rejectedSignals,
    }),
  );

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
