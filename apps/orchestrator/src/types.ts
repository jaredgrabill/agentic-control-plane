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
  /**
   * Set ONLY by the TaskWorkflow unwind loop when this dispatch is a
   * compensator for an already-completed write. Agents never construct a
   * StepDispatch, so this flag can only originate inside the orchestrator —
   * it is what routes the delegation through permit-compensation (no re-gate),
   * signs the token's compensation claim, and tags the step audits. A
   * require-approval verdict here is a policy bug that fails closed (a
   * compensator is pre-authorized by the original write's approval).
   */
  compensation?: CompensationDispatch;
}

/** Compensation provenance carried on a compensator's StepDispatch. */
export interface CompensationDispatch {
  /** step_id of the original write being reversed. */
  originalStepId: string;
  /** capability of the original write (e.g. change.submit). */
  originalCapability: string;
  /** The approval that authorized the original write, if it was gated. */
  approval?: ExecutedApproval;
}

/** The approval grounds recorded when a gated write executed (subset carried for compensation). */
export interface ExecutedApproval {
  approval_id: string;
  decision_id?: string;
  approver?: string;
  subject_digest?: string;
}

/**
 * What one AgentStepWorkflow actually executed — only the child knows the
 * discovered capability's risk and reversibility (dispatch-time discovery).
 * Present whenever the step reached the agent (regardless of outcome); the
 * TaskWorkflow reads it to decide whether to push a compensation-stack entry
 * (completed R2/R3 with a compensator) or record an irreversible write.
 */
export interface ExecutedWrite {
  agentId: string;
  agentVersion: string;
  risk: string;
  compensator?: string;
  irreversible?: boolean;
  approval?: ExecutedApproval;
}

/** AgentStepWorkflow's return: the step result plus what (if anything) executed. */
export interface StepExecution {
  result: StepResult;
  executed?: ExecutedWrite;
}

/**
 * One entry on the TaskWorkflow compensation stack: a completed R2/R3 write
 * with a declared compensator. Pushed in wave order (deterministic under
 * replay); the stack is unwound LIFO. The compensator's input is derived
 * mechanically from the recorded write (never attacker-supplied):
 * `{original: {step_id, capability, input, output}}`.
 */
export interface CompensationEntry {
  originalStepId: string;
  originalCapability: string;
  compensator: string;
  agentId: string;
  agentVersion: string;
  /** The original write's step input. */
  input: Record<string, unknown>;
  /** The original write's output — compensators often need the handles it returned. */
  output?: Record<string, unknown>;
  /** The approval that authorized the original write, if it was gated. */
  approval?: ExecutedApproval;
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

/** Signed compensation grounds threaded into a compensator's broker mint (mirrors the token service's CompensationGrounds). */
export interface CompensationTokenGrounds {
  original_step_id: string;
  original_capability: string;
  approval_id?: string;
  approver?: string;
}

/**
 * Signed capability grounds threaded into EVERY broker mint (mirrors the token
 * service's CapabilityGrounds): the executing capability's name and its
 * declared risk class. The tool gateway reads this (as context.capability) to
 * enforce risk classes on every tool call — an R0/R1 step cannot call an R2
 * tool. For a compensation dispatch the name/risk are the COMPENSATOR's own
 * declared capability (dispatch-time discovery), so a compensator carries its
 * true R2 risk and passes the gateway's structural check.
 */
export interface CapabilityTokenGrounds {
  name: string;
  risk: string;
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
    /**
     * Present only for a compensator dispatch — added to Cedar
     * `context.compensation` so permit-compensation (not the R2 gate) decides,
     * and the unwind is never lifted to require-approval.
     */
    compensation?: {
      originalStepId: string;
      originalCapability: string;
    };
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
    /**
     * Signed into the token's compensation claim when the step is a
     * compensator dispatched during a saga unwind. Mutually exclusive with
     * `approval` (the token service refuses both together).
     */
    compensation?: CompensationTokenGrounds;
    /**
     * Signed into the token's capability claim on EVERY mint — the executing
     * capability name + declared risk the tool gateway enforces risk classes
     * from. Independent of approval/compensation (a gated write carries both).
     */
    capability?: CapabilityTokenGrounds;
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
/**
 * Version-qualified agent task queue (item 4): `agent-{id}@{version}`. Two
 * versions of one agent serve DISTINCT queues, so the orchestrator dispatches a
 * canary/shadow step to the exact version's worker — the dispatch contract with
 * both SDKs (packages/agent-sdk agentTaskQueue / python agent_task_queue must
 * produce this byte-for-byte).
 */
export const agentTaskQueue = (agentId: string, version: string): string =>
  `agent-${agentId}@${version}`;
