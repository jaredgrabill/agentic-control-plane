/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

/**
 * The task contract: messages exchanged between the Gateway, the Orchestrator, and agents. A task message is exactly one of the four shapes below.
 */
export type TaskMessage = TaskRequest | TaskResult | StepRequest | StepResult;
export type Uuid = string;
export type TenantId = string;
export type Timestamp = string;
export type CapabilityName = string;

/**
 * A user task as submitted by the Gateway to the Orchestrator, attribution already stamped.
 */
export interface TaskRequest {
  kind: 'task_request';
  task_id: Uuid;
  tenant: TenantId;
  /**
   * Subject of the authenticated caller (JWT sub).
   */
  principal: string;
  session_id?: Uuid;
  input: {
    text: string;
    /**
     * Optional explicit capability route; absent means the orchestrator plans.
     */
    capability?: string;
    context?: {};
  };
  budget?: Budget;
  /**
   * The caller's platform JWT, consumed exactly once at intake by the orchestrator's snapshot activity (ADR-0007): verified claims are recorded into durable workflow state and per-step tokens are minted via the broker grant. Its ≤ 15-min TTL no longer bounds task duration.
   */
  subject_token?: string;
  submitted_at?: Timestamp;
}
export interface Budget {
  max_tokens?: number;
  max_steps?: number;
  max_cost_usd?: number;
}
/**
 * Terminal outcome of a task. Partial results are first-class: gaps are stated, never silently backfilled.
 */
export interface TaskResult {
  kind: 'task_result';
  task_id: Uuid;
  tenant: TenantId;
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  answer?: Answer;
  /**
   * For partial status: which sub-results are missing and why.
   */
  gaps?: string[];
  error?: CapabilityError;
  plan?: Plan;
  workflow_run_id?: string;
  completed_at?: Timestamp;
}
/**
 * Free-text answers ride inside a schema: text + citations + confidence.
 */
export interface Answer {
  text: string;
  citations: Citation[];
  confidence: number;
  /**
   * True when the agent declined to answer below its confidence floor.
   */
  abstained?: boolean;
}
export interface Citation {
  doc_id: string;
  version: string;
  effective_date?: string;
  url?: string;
  /**
   * UUIDv7 ledger key of the exact chunk version served.
   */
  lineage_id: string;
  snippet?: string;
}
/**
 * Typed failure; the orchestrator's behavior differs per class.
 */
export interface CapabilityError {
  class: 'retryable' | 'permanent' | 'budget_exhausted' | 'policy_denied' | 'needs_input';
  message: string;
  details?: {};
}
/**
 * Typed plan artifact materialized before execution and recorded to the audit stream (task.planned) — auditors see intent, not just outcomes. v1 plans are flat: no nesting, no mid-course replanning.
 */
export interface Plan {
  plan_id: Uuid;
  task_id: Uuid;
  tenant: TenantId;
  /**
   * Planner implementation and version, e.g. rule-planner@1.
   */
  planner: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  steps:
    | [PlanStep]
    | [PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep]
    | [PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep, PlanStep]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ]
    | [
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep,
        PlanStep
      ];
  rationale?: string;
  created_at: Timestamp;
}
export interface PlanStep {
  step_id: Uuid;
  capability: CapabilityName;
  /**
   * Optional pin; absent means registry discovery at dispatch time (kill-switch keeps stopping traffic per step).
   */
  agent_id?: string;
  input: {};
  /**
   * step_ids that must complete successfully first. A failed dependency skips this step (recorded as a gap), never retries the plan.
   */
  depends_on?: Uuid[];
  rationale?: string;
}
/**
 * One delegated step from the Orchestrator to one agent capability, dispatched as a Temporal activity. All state the handler needs is here — handlers are stateless.
 */
export interface StepRequest {
  kind: 'step_request';
  step_id: Uuid;
  task_id: Uuid;
  tenant: TenantId;
  agent_id: string;
  agent_version?: string;
  capability: CapabilityName;
  input: {};
  /**
   * 1 = delegated directly from the user task; +1 per re-delegation. Platform cap is 3 (agent-patterns.md); exceeding is a planning failure, never a retry.
   */
  delegation_depth?: number;
  /**
   * RFC 8693-exchanged JWT: audience = this agent, scopes = intersection, act chain included.
   */
  delegated_token?: string;
  budget?: Budget;
  trace_context?: TraceContext;
}
/**
 * W3C trace context propagated across bus and workflow hops.
 */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}
/**
 * Typed conclusion of a delegated step — a summary, never a transcript.
 */
export interface StepResult {
  kind: 'step_result';
  step_id: Uuid;
  task_id: Uuid;
  tenant: TenantId;
  status: 'completed' | 'failed';
  /**
   * Conforms to the capability's declared output_schema.
   */
  output?: {};
  error?: CapabilityError;
  usage?: Usage;
}
export interface Usage {
  /**
   * Non-cached input tokens only. Cache reads/writes are counted separately below and priced at their own rates; they do NOT count toward max_tokens.
   */
  input_tokens?: number;
  output_tokens?: number;
  /**
   * Input tokens served from the provider's prompt cache. Priced at the cache-read rate; excluded from max_tokens accounting.
   */
  cache_read_tokens?: number;
  /**
   * Input tokens written to the provider's prompt cache (cache creation). Priced at the cache-write rate; excluded from max_tokens accounting.
   */
  cache_write_tokens?: number;
  model?: string;
  llm_calls?: number;
  tool_calls?: number;
}
