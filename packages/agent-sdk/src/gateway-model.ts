/**
 * GatewayModel: ModelClient over the LLM Gateway (Phase 3 Item 0a). The
 * static prefix is fixed at construction and `complete(prompt)` always
 * sends the prompt as the variable tail — an agent physically cannot
 * order volatile content ahead of the cacheable prefix. Calls ride the
 * step's delegated token via withCallContext(); FakeModel remains the
 * unit-test seam, untouched.
 */

import { GatewayClient, LlmGatewayError, type PromptBlock } from '@acp/llm-client';
import { CapabilityError, ErrorClass } from './errors.js';
import type { ModelCallContext, ContextualModel, ModelClient, ModelResponse } from './model.js';

export interface GatewayModelOptions {
  /** LLM Gateway base URL (dev: http://localhost:7107). */
  url: string;
  /** A model CLASS from the manifest's models.allowed — never a model id. */
  modelClass: string;
  /** Cache-stable prefix (system prompt, rubric); sent as `prompt.static`. */
  staticPrefix?: PromptBlock[] | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class GatewayModel implements ContextualModel {
  private readonly client: GatewayClient;
  private readonly context: ModelCallContext | undefined;

  constructor(
    private readonly options: GatewayModelOptions,
    context?: ModelCallContext,
  ) {
    this.client = new GatewayClient({
      url: options.url,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.context = context;
  }

  /** A bound twin carrying one step's identity + correlation. */
  withCallContext(context: ModelCallContext): ModelClient {
    return new GatewayModel(this.options, context);
  }

  async complete(prompt: string, options?: { maxTokens?: number }): Promise<ModelResponse> {
    const context = this.context;
    const token = context?.delegatedToken;
    if (context === undefined || token === undefined) {
      throw new CapabilityError(
        ErrorClass.Permanent,
        'llm gateway calls require the step delegated token — the model is not bound to a call context',
      );
    }
    try {
      const response = await this.client.complete(
        {
          model_class: this.options.modelClass,
          prompt: {
            static: this.options.staticPrefix ?? [],
            variable: [{ role: 'user', text: prompt }],
          },
          max_tokens: options?.maxTokens ?? 1024,
          metadata: {
            task_id: context.taskId,
            step_id: context.stepId,
            capability: context.capability,
            purpose: 'agent',
          },
        },
        { token, taskId: context.taskId, stepId: context.stepId },
      );
      return {
        text: response.text,
        // Cache reads/writes are real processed input — the budget counts them.
        inputTokens:
          response.usage.input_tokens +
          response.usage.cache_read_input_tokens +
          response.usage.cache_creation_input_tokens,
        outputTokens: response.usage.output_tokens,
        model: response.model,
      };
    } catch (err) {
      throw toCapabilityError(err);
    }
  }
}

/**
 * The normative mapping: 429/5xx → Retryable (Temporal owns the retry
 * after the gateway's own failover gave up), 403 → PolicyDenied, every
 * other 4xx → Permanent.
 */
function toCapabilityError(err: unknown): CapabilityError {
  if (err instanceof CapabilityError) return err;
  if (err instanceof LlmGatewayError) {
    const details: Record<string, unknown> = {
      status: err.status,
      error_class: err.errorClass,
      ...(err.retryAfterS !== undefined ? { retry_after_s: err.retryAfterS } : {}),
    };
    if (err.status === 429 || err.status >= 500) {
      return new CapabilityError(ErrorClass.Retryable, err.message, details);
    }
    if (err.status === 403) {
      return new CapabilityError(ErrorClass.PolicyDenied, err.message, details);
    }
    return new CapabilityError(ErrorClass.Permanent, err.message, details);
  }
  return new CapabilityError(
    ErrorClass.Retryable,
    `llm gateway call failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}
