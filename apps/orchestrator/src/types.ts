import type {
  AgentCard,
  Answer,
  Budget,
  Plan,
  PlanStep,
  StepRequest,
  StepResult,
  TaskRequest,
} from '@acp/protocol';
import type { ProbeExpect, ProbeTarget } from '@acp/online-eval';
import type { ResolvedPriceBook } from '@acp/cost-meter/pricing';
import type { GateReport, GateThresholds } from './deployment-gates.js';

/**
 * Input to the singleton ProbeWorkflow (item 6). The probe suite + cadence are
 * passed in (the starter reads deploy config), so the isolate needs no fs and
 * continueAsNew carries the config across cycle rollovers.
 */
export interface ProbeWorkflowInput {
  interval_s: number;
  probe_failure_weight: number;
  targets: ProbeTarget[];
  /** Cycle counter within one workflow run; continueAsNew resets at 50. */
  cycle?: number;
}

export type { GateReport, GateThresholds } from './deployment-gates.js';

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
  /**
   * The agent id + version that executed the original write. A compensator is
   * PINNED to this exact version (resolveRoute pin), so the undo runs on the
   * same code that did the write — never re-routed to a canary/active that may
   * behave differently — and it is NEVER shadow-mirrored.
   */
  agentId: string;
  agentVersion: string;
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
  /**
   * The full plan + its digest (blast radius). OPTIONAL as of item 4 (deliberate
   * item-1 amendment): a deployment's owner-approval subject reuses this machine
   * but has no task plan — its blast radius is the version promotion itself,
   * carried in `input` ({from_version, to_version, gate_reports_digest}). Every
   * task-step approval still sets both; the digest binding is unaffected because
   * stableStringify drops undefined members.
   */
  plan?: Plan;
  plan_digest?: string;
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

/**
 * The version-aware routing decision for one step (item 4, D5). `route`
 * distinguishes the incumbent (`active`), a session-pinned canary
 * (`canary` — this task's bucket fell under the ramp), and a compensator pinned
 * to its original version (`pinned`). `bucket` is the deterministic
 * sha256(task_id)%100 — the same for every step of a task, so a task stays on
 * one version end-to-end (session pinning). `shadowCard`, present only during a
 * shadow soak (never for a pinned compensator), names the candidate to mirror.
 */
export interface RouteResult {
  card: AgentCard;
  route: 'active' | 'canary' | 'pinned';
  /** The canary ramp percentage this bucket was compared against (route==='canary'). */
  rampPercent?: number;
  /** Deterministic session bucket, sha256(task_id)%100. */
  bucket: number;
  /** The shadow candidate to mirror this step to (shadow soak only). */
  shadowCard?: AgentCard;
  /**
   * Online-eval (item 6): true when THIS step is selected for judged scoring.
   * Deterministic per (task_id, step_id); boosted to always-on during a shadow
   * soak so the incumbent is judged paired with the candidate. Never set for a
   * pinned compensator dispatch.
   */
  judge_sample?: boolean;
}

/**
 * Input to the JudgeScoreWorkflow — a fire-and-forget judged score of one
 * completed step (item 6). Carries the input + output text in-hand at step
 * completion (the only place the full output exists; audit keeps digests only).
 */
export interface JudgeScoreInput {
  task_id: string;
  step_id: string;
  tenant: string;
  agent_id: string;
  agent_version: string;
  capability: string;
  /** The route the scored step ran (shadow scores feed only deployment gates). */
  route: 'active' | 'canary' | 'shadow';
  input: Record<string, unknown>;
  /** The step's Answer-envelope output; null on a failed step. */
  output: Record<string, unknown> | null;
  status: 'completed' | 'failed';
}

/** Input to the ShadowStepWorkflow — a fire-and-forget mirror of one primary step. */
export interface ShadowStepInput {
  taskId: string;
  stepId: string;
  tenant: string;
  principal: string;
  snapshot: PrincipalSnapshot;
  capability: string;
  input: Record<string, unknown>;
  /** The shadow candidate card (agent id + version + declared capability). */
  shadowCard: AgentCard;
  /** The incumbent version this shadow is compared against (for the gate join). */
  incumbentVersion: string;
}

/** Deployment tunables (D7); every field is overridable so E2E runs seconds-scale. */
export interface DeploymentConfig {
  shadow_soak_s: number;
  min_shadow_samples: number;
  ramp_steps: number[];
  ramp_soak_s: number;
  drain_s: number;
  thresholds: GateThresholds;
}

/** The default deployment profile (production-scale soaks). */
export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  shadow_soak_s: 3600,
  min_shadow_samples: 5,
  ramp_steps: [5, 25, 50, 100],
  ramp_soak_s: 1800,
  drain_s: 3600,
  thresholds: {
    max_success_delta: 0.05,
    max_p95_ratio: 1.5,
    max_cost_ratio: 1.25,
    min_shadow_completion: 0.9,
    min_shadow_samples: 5,
    max_quality_delta: 0.1,
    min_quality_samples: 5,
  },
};

/** Internal input to the DeploymentWorkflow. */
export interface DeploymentRequest {
  deployment_id: string;
  agent_id: string;
  candidate_version: string;
  initiated_by: string;
  /** The tenant whose shadow/canary traffic the gates evaluate (task tenant). */
  tenant: string;
  config: DeploymentConfig;
}

/** What beginDeployment resolves after validating the candidate against the incumbent. */
export interface DeploymentPreflight {
  /** The current active version being replaced; undefined on a first-ever deployment. */
  incumbentVersion?: string;
  /** The candidate's declared capabilities and their max risk (drives the R2 approval gate). */
  capabilities: string[];
  /** True when any candidate capability is R2/R3 — final promotion needs owner approval. */
  requiresApproval: boolean;
  /** Baseline comparison note recorded on deployment.started (e.g. 'incomparable_suite'). */
  baselineNote: string;
}

/** The verdict of the pre-dispatch kill-switch checkpoint (checkKillSwitch activity). */
export type KillSwitchVerdict =
  | { halted: false }
  | {
      halted: true;
      tier: 'capability' | 'risk' | 'fleet' | 'agent';
      target: string;
      reason: string;
    };

/** Control-plane activities implemented by the orchestrator's own worker. */
export interface ControlActivities {
  /**
   * Tier-2/3 kill-switch checkpoint (item 5, checkpoint 1). Answers from the
   * worker's in-memory KillSwitchWatcher (fast path). The compensation-exemption
   * matrix is enforced HERE so it is identical wherever the activity is called:
   * a named-capability or agent flag blocks even a compensator (surgical intent
   * wins), while a fleet halt or a covering risk-class flag is EXEMPT for a
   * compensator (else a halt would make an in-flight write permanently
   * un-compensable — the kill switch would preserve the danger). Called before
   * authorizeDelegation and again after an approval wait (symmetric with the
   * re-discovery), so a suspension DURING a gate still fails the step closed.
   */
  checkKillSwitch(input: {
    capability: string;
    risk: string;
    agentId: string;
    /** True when this dispatch is a saga compensator (unwind) — fleet/risk exempt. */
    compensation: boolean;
  }): Promise<KillSwitchVerdict>;
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
   * Version-aware routing (item 4, D5). Reads the registry routing set for a
   * capability, computes the deterministic session bucket, and returns the card
   * to run plus any shadow candidate to mirror. A `pin` (a compensator's
   * original agent+version) routes to exactly that version and never mirrors.
   * Returns null when nothing serves the capability.
   */
  resolveRoute(input: {
    capability: string;
    tenant: string;
    taskId: string;
    /** The step being routed — feeds deterministic per-step judge sampling (item 6). */
    stepId?: string;
    pin?: { agentId: string; version: string };
  }): Promise<RouteResult | null>;
  /**
   * Online-eval (item 6): score one completed step with the calibrated judge
   * and ingest the result. Gated judge call (an uncalibrated/failed judge is a
   * JUDGE condition, never an agent quality observation) → embed the input →
   * POST the score to the eval service (idempotent) → emit eval.score. Catches
   * everything: a scoring failure must never disturb the (abandoned) workflow
   * or, via the shadow path, the primary step. A failed step is ingested as a
   * quality observation (passed:false) with no LLM call.
   */
  scoreWithJudge(input: JudgeScoreInput): Promise<void>;
  /**
   * Online-eval probes (item 6): mint a fresh subject token for the synthetic
   * prober (client_creds svc-prober, aud acp:gateway) so a probe runs the real
   * trust path minus intake. Returns the token and its principal (for the probe
   * TaskRequest attribution).
   */
  mintProbeSubject(): Promise<{ token: string; principal: string }>;
  /**
   * Online-eval probes (item 6): score one probe case against its golden
   * expectations (judge-independent), POST the result to the eval service, and
   * emit eval.probe_result. Resolves the active serving version + owner from the
   * registry. Catches everything (a probe recording failure is not an incident).
   */
  recordProbeResult(input: {
    agent_id: string;
    capability: string;
    tenant: string;
    case_name: string;
    expect: ProbeExpect;
    weight: number;
    answer: Answer | null;
    task_id: string;
    duration_ms: number;
  }): Promise<{ passed: boolean }>;
  /**
   * Online-eval probes (item 6): logs a warning for every active agent lacking
   * probe coverage, so "every active agent is probed" is visible not silently
   * false. Returns the uncovered agent ids.
   */
  listProbeTargets(input: { covered: string[] }): Promise<{ uncovered: string[] }>;
  /**
   * Online-eval change freeze (item 6, D5). Reads the agent's quality budget
   * from the eval service. FAIL-CLOSED: an unreachable eval service returns
   * frozen:true (reason freeze_check_unavailable) — a deployment must not
   * proceed when the safety signal is unavailable (matches the item-4 gate
   * posture). DeploymentWorkflow calls it before candidate validation and again
   * before promotion.
   */
  checkQualityFreeze(agentId: string): Promise<{
    frozen: boolean;
    reason?: string;
    burn_ratio?: number;
  }>;
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
    /**
     * Signed into the token's deployment claim — present ONLY when the
     * ShadowStepWorkflow brokers a shadow step token. The tool gateway reads it
     * to suppress side effects for the shadow step.
     */
    deployment?: { mode: string };
  }): Promise<{ token: string }>;
  /** Protocol-validated audit emission (JetStream-acked). */
  emitAudit(event: Record<string, unknown>): Promise<void>;
  /** sha256 over the canonical form of a value (the shadow result's output digest). */
  digestValue(value: unknown): Promise<{ digest: string }>;

  // --- Deployment Controller (item 4) ---
  /**
   * Validates a candidate before a deployment starts: it must be `registered`
   * with a baseline whose id/version match; the current active version becomes
   * the incumbent (a first-ever deployment has none — the workflow uses an admin
   * bootstrap). Returns the candidate's capabilities/risk and a baseline-
   * comparison note (same suite → candidate ≥ incumbent − tolerance; different
   * suite → 'incomparable_suite', recorded and allowed).
   */
  beginDeployment(input: {
    agentId: string;
    candidateVersion: string;
  }): Promise<DeploymentPreflight>;
  /** Drives a registry versioned lifecycle transition with the controller's registry:deploy scope. */
  deployTransition(input: {
    agentId: string;
    version: string;
    state: string;
    rampPercent?: number;
    reason?: string;
  }): Promise<void>;
  /** Atomic promote (registry POST /promote): candidate canary→active, incumbent active→deprecated. */
  promoteVersion(input: { agentId: string; version: string }): Promise<void>;
  /**
   * Fetches the audit window and runs the GateEvaluator. `kind` selects the
   * shadow (join shadow_result to primary) or canary (split by version) math.
   */
  evaluateGate(input: {
    kind: 'shadow' | 'canary';
    tenant: string;
    since: string;
    /** The agent id, for the item-6 judged-quality fold (scores by version+route). */
    agentId?: string;
    candidateVersion: string;
    incumbentVersion?: string;
    thresholds: GateThresholds;
  }): Promise<GateReport>;
  /** Current ISO time (activity-side wall clock) for gate window boundaries. */
  now(): Promise<{ iso: string }>;
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
