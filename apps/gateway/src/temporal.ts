import type { TaskRequest, TaskResult } from '@acp/protocol';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { env } from '@acp/service-kit';
import type { TaskStarter } from './app.js';

export const TASK_QUEUE = 'acp-tasks';

/** Deterministic workflow id: tenant-scoped so status lookups cannot cross tenants. */
export function taskWorkflowId(tenant: string, taskId: string): string {
  return `task-${tenant}-${taskId}`;
}

export async function connectTemporal(): Promise<TemporalTaskStarter> {
  const connection = await Connection.connect({
    address: env('ACP_TEMPORAL_ADDRESS', 'localhost:7233'),
  });
  const client = new Client({
    connection,
    namespace: env('ACP_TEMPORAL_NAMESPACE', 'default'),
  });
  return new TemporalTaskStarter(client);
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
}
