/**
 * Deterministic workflow code (Temporal V8 isolate): no IO, no wall clocks
 * beyond the patched Date, no randomness beyond uuid4(). Everything
 * effectful is an activity.
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
  Answer,
  StepRequest,
  StepResult,
  TaskRequest,
  TaskResult,
} from '@acp/protocol';
import { agentTaskQueue, type AgentActivities, type ControlActivities } from './types.js';

const control = proxyActivities<ControlActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

/** v0 routing rule: unrouted questions go to the knowledge agent. */
const DEFAULT_CAPABILITY = 'knowledge.answer_with_citations';

export async function TaskWorkflow(task: TaskRequest): Promise<TaskResult> {
  const capability = task.input.capability ?? DEFAULT_CAPABILITY;

  const card = await control.discoverAgent(capability, task.tenant);
  if (card === null) {
    // Suspension stops new traffic here: a suspended agent is not `active`
    // in the registry, so discovery simply stops returning it.
    return fail(task, {
      class: 'permanent',
      message:
        `no active agent serves capability ${capability} in tenant ${task.tenant} — ` +
        'the agent may be suspended or not yet promoted (check the registry)',
    });
  }

  const step = await executeChild(AgentStepWorkflow, {
    args: [task, card, capability],
    workflowId: `${workflowInfo().workflowId}-step-${uuid4()}`,
  });

  if (step.status === 'failed' || step.output === undefined) {
    return fail(task, step.error ?? { class: 'permanent', message: 'step returned no output' });
  }
  return {
    kind: 'task_result',
    task_id: task.task_id,
    tenant: task.tenant,
    status: 'completed',
    answer: step.output as unknown as Answer,
    workflow_run_id: workflowInfo().runId,
    completed_at: new Date().toISOString(),
  };
}

export async function AgentStepWorkflow(
  task: TaskRequest,
  card: AgentCard,
  capability: string,
): Promise<StepResult> {
  const stepId = uuid4();
  const declared = card.manifest.capabilities.find((c) => c.name === capability);
  if (declared === undefined) {
    throw ApplicationFailure.nonRetryable(
      `agent ${card.manifest.id} does not declare capability ${capability}`,
    );
  }
  if (task.subject_token === undefined) {
    return {
      kind: 'step_result',
      step_id: stepId,
      task_id: task.task_id,
      tenant: task.tenant,
      status: 'failed',
      error: {
        class: 'permanent',
        message: 'task carries no subject_token — the gateway must forward the caller credential',
      },
    };
  }

  // Scopes the delegation may carry: the target's manifest bindings. The
  // token service intersects these with what the subject token holds —
  // delegation narrows, never widens.
  const requestedScopes = (card.manifest.tools ?? []).flatMap((t) => t.scopes);

  const decision = await control.authorizeDelegation({
    principal: task.principal,
    tenant: task.tenant,
    agent: card,
    capability,
    subjectToken: task.subject_token,
    requestedScopes,
    taskId: task.task_id,
    stepId,
  });
  if (decision.decision !== 'allow') {
    return {
      kind: 'step_result',
      step_id: stepId,
      task_id: task.task_id,
      tenant: task.tenant,
      status: 'failed',
      error: {
        class: 'policy_denied',
        message:
          `policy denied delegation of ${capability} to ${card.manifest.id} ` +
          `(bundle ${decision.bundle_version}) — the principal's scopes or the capability's ` +
          'risk class do not satisfy any permit',
      },
    };
  }
  const { token } = await control.exchangeToken({
    subjectToken: task.subject_token,
    agent: card,
    scopes: requestedScopes,
  });

  const request: StepRequest = {
    kind: 'step_request',
    step_id: stepId,
    task_id: task.task_id,
    tenant: task.tenant,
    agent_id: card.manifest.id,
    agent_version: card.version,
    capability,
    input:
      capability === DEFAULT_CAPABILITY
        ? { question: task.input.text }
        : (task.input.context ?? { text: task.input.text }),
    delegated_token: token,
    ...(task.budget !== undefined ? { budget: task.budget } : {}),
  };

  await control.emitAudit(
    auditEvent(task, 'step.dispatched', stepId, card, {
      capability,
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
    auditEvent(task, 'step.completed', stepId, card, {
      capability,
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

function auditEvent(
  task: TaskRequest,
  eventType: 'step.dispatched' | 'step.completed',
  stepId: string,
  card: AgentCard,
  details: Record<string, unknown>,
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
    reason: { task_id: task.task_id, step_id: stepId },
    artifacts: {
      agent_id: card.manifest.id,
      agent_version: card.version,
      workflow_run_id: workflowInfo().runId,
    },
    details,
  };
}
