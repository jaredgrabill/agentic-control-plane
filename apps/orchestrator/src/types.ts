import type {
  AgentCard,
  Budget,
  Plan,
  PlanStep,
  StepRequest,
  StepResult,
  TaskRequest,
} from '@acp/protocol';
import type { ResolvedPriceBook } from '@acp/cost-meter/pricing';

/**
 * Delegation depth cap (agent-patterns.md): 1 = delegated directly from the
 * user task, +1 per re-delegation. Exceeding it is a planning failure —
 * flatten the plan — never a retry.
 */
export const MAX_DELEGATION_DEPTH = 3;

/**
 * The verified claims of the task's principal, recorded ONCE at intake
 * (ADR-0007) and durable in workflow state. Every later authorization and
 * token mint works from this snapshot; the raw subject token is never read
 * again.
 */
export interface PrincipalSnapshot {
  sub: string;
  tenant: string;
  roles: string[];
  scopes: string[];
  /** jti of the intake subject token — joins broker mints to the intake verification. */
  jti?: string;
  verified_at: string;
}

/**
 * Everything one AgentStepWorkflow needs — no subject token, by design:
 * the snapshot carries the principal's verified context instead.
 */
export interface StepDispatch {
  taskId: string;
  tenant: string;
  principal: string;
  snapshot: PrincipalSnapshot;
  planStep: PlanStep;
  planRef: { planId: string; index: number; total: number };
  /** Delegation depth of this step; the child enforces MAX_DELEGATION_DEPTH. */
  depth: number;
  /** REMAINING task budget at dispatch time, not the whole task budget. */
  budget?: Budget;
}

/** Control-plane activities implemented by the orchestrator's own worker. */
export interface ControlActivities {
  /**
   * ADR-0007 intake verification: verifies the forwarded subject token
   * (audience acp:gateway) while it is fresh and snapshots the verified
   * claims. The only activity that ever sees the subject token.
   */
  snapshotPrincipal(input: {
    subjectToken: string;
    expectedPrincipal: string;
    expectedTenant: string;
  }): Promise<PrincipalSnapshot>;
  /**
   * Materializes the typed plan artifact for a task (rule-planner@1 in v1;
   * an LLM planner swaps in behind the same schema validation).
   */
  planTask(task: TaskRequest): Promise<{ plan: Plan; planDigest: string }>;
  /** Registry lookup: active agents serving a capability. Truth, not bus scanning. */
  discoverAgent(capability: string, tenant: string): Promise<AgentCard | null>;
  /**
   * Cedar decision for one delegation. The orchestrator is the PEP for
   * agent-to-agent and user-to-agent delegation. Presents the principal's
   * actually-held scopes from the intake snapshot — never the manifest's
   * wishlist.
   */
  authorizeDelegation(input: {
    principal: string;
    tenant: string;
    agent: AgentCard;
    capability: string;
    snapshot: PrincipalSnapshot;
    /** Scopes the delegation would carry (manifest bindings) — context for future policies. */
    requestedScopes: string[];
    taskId: string;
    stepId: string;
  }): Promise<{
    decision: 'allow' | 'deny';
    bundle_version: string;
    determining_policies: string[];
  }>;
  /**
   * ADR-0007 broker grant: mints the step's delegated token at dispatch
   * time from the snapshot — audience-bound to the agent, scopes
   * intersected, act chain grown, TTL ≤ 15 min.
   */
  brokerToken(input: {
    snapshot: PrincipalSnapshot;
    agent: AgentCard;
    scopes: string[];
    taskId: string;
  }): Promise<{ token: string }>;
  /** Protocol-validated audit emission (JetStream-acked). */
  emitAudit(event: Record<string, unknown>): Promise<void>;
  /**
   * Loads and resolves the current price book to integer micro-USD rates
   * (Cost Meter). Called once per task; the resolved book is pinned into
   * workflow state and its version recorded in the task audit. On failure
   * the workflow fails closed only when max_cost_usd is set — otherwise cost
   * recording is disabled and the task proceeds.
   */
  getPriceBook(): Promise<ResolvedPriceBook>;
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
