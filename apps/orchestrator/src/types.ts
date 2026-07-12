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
  /** The full plan and its digest — carried so the approval subject can show an approver the whole plan (blast radius). */
  plan: Plan;
  planDigest: string;
}

/** Timeouts governing an approval gate. No per-task override in v1. */
export const APPROVAL_ESCALATE_AFTER_S = 3600;
export const APPROVAL_DENY_AFTER_S = 86_400;

/**
 * The full context an approver must see before deciding (governance-and-policy:
 * approvals carry plan, blast radius, compensator). Minted by AgentStepWorkflow
 * from the card + planStep + dispatch when a delegation lifts to
 * require-approval. Internal to the orchestrator — NOT a protocol type — but
 * its sha256 (subject_digest) binds the whole thing to the decision and the
 * eventual token.
 */
export interface ApprovalSubject {
  /** uuid minted by AgentStepWorkflow — the ApprovalWorkflow instance id. */
  approval_id: string;
  task_id: string;
  step_id: string;
  tenant: string;
  /** The task's principal — the party on whose behalf the write would run. */
  principal: string;
  agent_id: string;
  agent_version: string;
  capability: string;
  risk: string;
  /** The EXACT step input the approver sees and authorizes. */
  input: Record<string, unknown>;
  requested_scopes: string[];
  /** The compensator capability declared for this write, if any (reversibility). */
  compensator?: string;
  /** True when the write is flagged irreversible — raises the approval bar (visibility v1). */
  irreversible?: boolean;
  plan: Plan;
  plan_digest: string;
}

/** Input to the ApprovalWorkflow child. */
export interface ApprovalGateInput {
  subject: ApprovalSubject;
  /** sha256 over stableStringify(subject), computed by an activity (no crypto in the isolate). */
  subject_digest: string;
  escalate_after_s: number;
  deny_after_s: number;
}

/**
 * A human decision entering the workflow via signal. Minted by the gateway
 * route from a VERIFIED approver JWT — approver is claims.sub, never body.
 * The workflow re-validates independently (defense in depth).
 */
export interface ApprovalDecisionSignal {
  decision: 'approve' | 'deny';
  decision_id: string;
  approver: string;
  approver_chain: { sub: string }[];
  /** Echo of the subject_digest the approver was shown — mismatch is rejected as stale/forged. */
  subject_digest: string;
  note?: string;
}

/** The ApprovalWorkflow result AgentStepWorkflow acts on. */
export interface ApprovalOutcome {
  granted: boolean;
  reason: 'approved' | 'denied' | 'timeout';
  approval_id: string;
  decision_id?: string;
  approver?: string;
  latency_ms: number;
  subject_digest: string;
}

/** Signed approval grounds threaded into the broker mint (mirrors the token service's ApprovalGrounds). */
export interface ApprovalTokenGrounds {
  approval_id: string;
  decision_id: string;
  approver: string;
  step_id: string;
  capability: string;
  subject_digest: string;
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
    decision: 'allow' | 'deny' | 'require-approval';
    bundle_version: string;
    determining_policies: string[];
  }>;
  /**
   * sha256 over stableStringify(subject) for an approval gate. Done in an
   * activity because the workflow isolate has no crypto — the digest binds
   * the exact subject the approver sees to the decision and the token.
   */
  digestApprovalSubject(subject: ApprovalSubject): Promise<{ subject_digest: string }>;
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
    /** Signed into the token's approval claim when the step passed an approval gate. */
    approval?: ApprovalTokenGrounds;
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
