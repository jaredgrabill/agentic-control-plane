import type { AgentCard, StepRequest, StepResult } from '@acp/protocol';

/** Control-plane activities implemented by the orchestrator's own worker. */
export interface ControlActivities {
  /** Registry lookup: active agents serving a capability. Truth, not bus scanning. */
  discoverAgent(capability: string, tenant: string): Promise<AgentCard | null>;
  /** Cedar decision for one delegation. The orchestrator is the PEP for agent-to-agent and user-to-agent delegation. */
  authorizeDelegation(input: {
    principal: string;
    tenant: string;
    agent: AgentCard;
    capability: string;
    scopes: string[];
    taskId: string;
    stepId: string;
  }): Promise<{
    decision: 'allow' | 'deny';
    bundle_version: string;
    determining_policies: string[];
  }>;
  /** RFC 8693: subject token → agent-audience token, scopes intersected, act chain grown. */
  exchangeToken(input: {
    subjectToken: string;
    agent: AgentCard;
    scopes: string[];
  }): Promise<{ token: string }>;
  /** Protocol-validated audit emission (JetStream-acked). */
  emitAudit(event: Record<string, unknown>): Promise<void>;
}

/**
 * The single activity every agent worker implements, registered on the
 * agent's own task queue. The orchestrator invokes it by name across the
 * language boundary — this signature IS the polyglot contract.
 */
export interface AgentActivities {
  execute_capability(request: StepRequest): Promise<StepResult>;
}

export const CONTROL_TASK_QUEUE = 'acp-tasks';
export const agentTaskQueue = (agentId: string): string => `agent-${agentId}`;
