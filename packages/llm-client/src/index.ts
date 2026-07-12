/**
 * @acp/llm-client — LLM Gateway wire types, Ajv validators, and the
 * GatewayClient used by the SDK's GatewayModel and by platform callers
 * (judge harness, planner, synthesis).
 */

export {
  GatewayClient,
  LlmGatewayError,
  type CompleteOptions,
  type GatewayClientOptions,
} from './client.js';
export {
  completionRequest,
  completionRequestSchema,
  completionResponse,
  completionResponseSchema,
  llmErrorBody,
  llmErrorBodySchema,
} from './schema.js';
export type {
  CompletionAttempt,
  CompletionMetadata,
  CompletionPrompt,
  CompletionPurpose,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  LlmErrorBody,
  LlmErrorClass,
  ModelClassesResponse,
  PromptBlock,
  PromptRole,
} from './types.js';
