import type { TaskRequest, TaskResult } from '@acp/protocol';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import { env } from '@acp/service-kit';
import type { ApprovalDecisionInput, ApprovalGateway, ApprovalView, TaskStarter } from './app.js';

export const TASK_QUEUE = 'acp-tasks';

/** Signal/query names the ApprovalWorkflow registers (apps/orchestrator/src/workflows.ts). */
const APPROVAL_DECISION_SIGNAL = 'approvalDecision';
const APPROVAL_STATUS_QUERY = 'approvalStatus';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Deterministic workflow id: tenant-scoped so status lookups cannot cross tenants. */
export function taskWorkflowId(tenant: string, taskId: string): string {
  return `task-${tenant}-${taskId}`;
}

/** The ApprovalWorkflow instance id — the approval id is a uuid (validated before interpolation). */
export function approvalWorkflowId(approvalId: string): string {
  return `approval-${approvalId}`;
}

export async function connectTemporal(): Promise<{
  starter: TemporalTaskStarter;
  approvals: TemporalApprovalGateway;
}> {
  const connection = await Connection.connect({
    address: env('ACP_TEMPORAL_ADDRESS', 'localhost:7233'),
  });
  const client = new Client({
    connection,
    namespace: env('ACP_TEMPORAL_NAMESPACE', 'default'),
    // Carries the gateway's trace context into the workflow — one trace
    // from HTTP intake through the agent's activities.
    interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
  });
  return {
    starter: new TemporalTaskStarter(client),
    approvals: new TemporalApprovalGateway(client),
  };
}

export class TemporalTaskStarter implements TaskStarter {
  constructor(private readonly client: Client) {}

  async start(request: TaskRequest): Promise<{ workflowRunId: string }> {
    const handle = await this.client.workflow.start('TaskWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: taskWorkflowId(request.tenant, request.task_id),
      args: [request],
      // Task intake is idempotent on task_id: a client retry of the same
      // submission must not spawn a second workflow.
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    return { workflowRunId: handle.firstExecutionRunId };
  }

  async status(
    tenant: string,
    taskId: string,
  ): Promise<{ status: 'running' | 'completed' | 'failed' | 'not_found'; result?: TaskResult }> {
    const handle = this.client.workflow.getHandle(taskWorkflowId(tenant, taskId));
    try {
      const description = await handle.describe();
      switch (description.status.name) {
        case 'RUNNING':
        case 'CONTINUED_AS_NEW':
        case 'PAUSED':
          return { status: 'running' };
        case 'COMPLETED':
          return { status: 'completed', result: (await handle.result()) as TaskResult };
        case 'UNSPECIFIED':
        case 'FAILED':
        case 'CANCELLED':
        case 'TERMINATED':
        case 'TIMED_OUT':
        case 'UNKNOWN':
          return { status: 'failed' };
      }
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        return { status: 'not_found' };
      }
      throw err;
    }
  }

  /**
   * Requests cooperative cancellation of a running task. The workflow id is
   * tenant-scoped, so a cross-tenant cancel is structurally a not_found — a
   * foreign task id can never be probed. A terminal workflow returns
   * `already_terminal` (409, not an error): the drain-then-unwind already ran
   * or the task finished. The TaskWorkflow catches the cancel, drains the
   * in-flight wave, unwinds the compensation stack, and returns an honest
   * `cancelled` result — it does NOT fault.
   */
  async cancel(
    tenant: string,
    taskId: string,
  ): Promise<{ outcome: 'cancelling' | 'not_found' | 'already_terminal' }> {
    const handle = this.client.workflow.getHandle(taskWorkflowId(tenant, taskId));
    try {
      const description = await handle.describe();
      if (description.status.name !== 'RUNNING' && description.status.name !== 'CONTINUED_AS_NEW') {
        return { outcome: 'already_terminal' };
      }
      await handle.cancel();
      return { outcome: 'cancelling' };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        return { outcome: 'not_found' };
      }
      throw err;
    }
  }
}

/** The shape the ApprovalWorkflow's approvalStatus query returns. */
interface ApprovalStatusQueryResult {
  status: 'pending' | 'granted' | 'denied' | 'timeout';
  subject: ApprovalView['subject'];
  subject_digest: string;
  requested_at: string;
  escalated: boolean;
  rejected_signals: number;
}

/**
 * Reads and decides approvals against the running ApprovalWorkflow — the
 * source of truth (immune to audit lag). A missing OR cross-tenant workflow
 * reads as absent so foreign approval ids cannot be probed.
 */
export class TemporalApprovalGateway implements ApprovalGateway {
  constructor(private readonly client: Client) {}

  async status(approvalId: string, tenant: string): Promise<ApprovalView | undefined> {
    if (!UUID_RE.test(approvalId)) return undefined;
    const handle = this.client.workflow.getHandle(approvalWorkflowId(approvalId));
    let closed: boolean;
    try {
      const description = await handle.describe();
      closed = description.status.name !== 'RUNNING';
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return undefined;
      throw err;
    }
    let view: ApprovalStatusQueryResult;
    try {
      view = await handle.query<ApprovalStatusQueryResult>(APPROVAL_STATUS_QUERY);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return undefined;
      throw err;
    }
    // Cross-tenant reads as absent (404 at the route), never leaking the
    // existence of another tenant's approval.
    if (view.subject.tenant !== tenant) return undefined;
    // A closed workflow whose query still reports pending timed out (deny by
    // default) — surface it as terminal so a decision attempt gets 409, never
    // a signal to a workflow that can no longer accept it.
    const status = closed && view.status === 'pending' ? 'timeout' : view.status;
    return {
      status,
      subject: view.subject,
      subject_digest: view.subject_digest,
      requested_at: view.requested_at,
      escalated: view.escalated,
    };
  }

  async decide(approvalId: string, signal: ApprovalDecisionInput): Promise<void> {
    if (!UUID_RE.test(approvalId)) {
      throw new Error(`refusing to signal a non-uuid approval id ${JSON.stringify(approvalId)}`);
    }
    const handle = this.client.workflow.getHandle(approvalWorkflowId(approvalId));
    await handle.signal(APPROVAL_DECISION_SIGNAL, signal);
  }
}
