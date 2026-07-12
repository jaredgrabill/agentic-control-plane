/**
 * The LLM Gateway wire shapes (Phase 3 Item 0a). Deliberately app-local —
 * not protocol schemas — until a Python consumer appears; the gateway and
 * every TS caller share this one definition, Ajv-validated on both ends.
 *
 * The prompt is block-structured with a hard static/variable split: the
 * static prefix (system prompt, tool schemas, rubric) travels separately
 * from the variable tail (retrieved context, user input), so a
 * cache-hostile volatile-before-static layout is inexpressible on the wire
 * (cost-management.md lever 1).
 */

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptBlock {
  role: PromptRole;
  text: string;
}

export interface CompletionPrompt {
  /** Byte-stable prefix, assembled first. At most 4 blocks. */
  static: PromptBlock[];
  /** Volatile tail, assembled after the static prefix. At least 1 block. */
  variable: PromptBlock[];
}

/** Why the completion is happening — feeds cost attribution and audit. */
export type CompletionPurpose = 'agent' | 'judge' | 'planner' | 'synthesis' | 'probe';

export interface CompletionMetadata {
  task_id?: string;
  step_id?: string;
  capability?: string;
  purpose?: CompletionPurpose;
}

export interface CompletionRequest {
  /** A model CLASS from acp-model-classes/v1 — never a concrete model id. */
  model_class: string;
  prompt: CompletionPrompt;
  /** Defaults to 1024 (the SDK's ModelClient default). */
  max_tokens?: number;
  /** Defaults to 0. */
  temperature?: number;
  metadata?: CompletionMetadata;
}

export interface CompletionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One provider attempt in the gateway's intra-call failover loop. */
export interface CompletionAttempt {
  provider: string;
  model: string;
  /** `ok` or the fault that ended the attempt (`rate_limited`, `server`, …). */
  outcome: string;
  duration_ms: number;
}

export interface CompletionResponse {
  text: string;
  model_class: string;
  /** The concrete model that answered — the Cost Meter's price-book key. */
  model: string;
  provider: string;
  model_classes_version: string;
  usage: CompletionUsage;
  attempts: CompletionAttempt[];
}

/** Closed error vocabulary — the client maps these onto CapabilityError deterministically. */
export type LlmErrorClass =
  | 'invalid_input'
  | 'unauthenticated'
  | 'model_not_allowed'
  | 'model_class_unknown'
  | 'rate_limited'
  | 'unavailable'
  | 'killswitch';

export interface LlmErrorBody {
  error: {
    class: LlmErrorClass;
    message: string;
    status: number;
    retry_after_s?: number;
  };
}

export interface ModelClassesResponse {
  version: string;
  classes: Record<string, { models: string[] }>;
}
