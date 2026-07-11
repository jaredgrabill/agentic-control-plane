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
   * The caller's platform JWT, forwarded so the orchestrator can perform RFC 8693 exchange per delegation (scopes intersect, act chain grows). TTL ≤ 15 min bounds its life in workflow state; v0 supports single-step tasks that complete within it — durable re-delegation is a Phase 2 concern.
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
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  llm_calls?: number;
  tool_calls?: number;
}
