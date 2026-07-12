/**
 * GatewayClient: the one HTTP door to the LLM Gateway. Non-agent callers
 * (judge harness, planner, synthesis) use it directly with an `acp:llm`
 * service token; agents never see it — they get the SDK's GatewayModel,
 * which wraps this client behind the ModelClient seam.
 */

import { completionResponse, llmErrorBody } from './schema.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LlmErrorClass,
  ModelClassesResponse,
} from './types.js';

/** A typed gateway refusal or failure — never a bare fetch error. */
export class LlmGatewayError extends Error {
  readonly errorClass: LlmErrorClass;
  readonly status: number;
  readonly retryAfterS: number | undefined;

  constructor(errorClass: LlmErrorClass, message: string, status: number, retryAfterS?: number) {
    super(message);
    this.name = 'LlmGatewayError';
    this.errorClass = errorClass;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

export interface CompleteOptions {
  /** Bearer token: an `acp:llm` service token or the step's delegated agent token. */
  token: string;
  taskId?: string | undefined;
  stepId?: string | undefined;
}

export interface GatewayClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
}

/** Fallback mapping when a proxy answers without a typed gateway body. */
function classForStatus(status: number): LlmErrorClass {
  if (status === 400) return 'invalid_input';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'model_not_allowed';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export class GatewayClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    request: CompletionRequest,
    options: CompleteOptions,
  ): Promise<CompletionResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
      ...(options.taskId !== undefined ? { 'x-acp-task-id': options.taskId } : {}),
      ...(options.stepId !== undefined ? { 'x-acp-step-id': options.stepId } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/v1/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new LlmGatewayError(
        'unavailable',
        `llm gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      if (llmErrorBody.validate(body)) {
        throw new LlmGatewayError(
          body.error.class,
          body.error.message,
          res.status,
          body.error.retry_after_s,
        );
      }
      throw new LlmGatewayError(
        classForStatus(res.status),
        `llm gateway request failed (${res.status})`,
        res.status,
      );
    }
    if (!completionResponse.validate(body)) {
      throw new LlmGatewayError(
        'unavailable',
        `llm gateway returned a malformed completion response: ${completionResponse
          .errors(body)
          .slice(0, 3)
          .join('; ')}`,
        502,
      );
    }
    return body;
  }

  async modelClasses(options: { token: string }): Promise<ModelClassesResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/v1/model-classes`, {
        headers: { authorization: `Bearer ${options.token}` },
      });
    } catch (err) {
      throw new LlmGatewayError(
        'unavailable',
        `llm gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }
    if (!res.ok) {
      throw new LlmGatewayError(
        classForStatus(res.status),
        `llm gateway refused /v1/model-classes (${res.status})`,
        res.status,
      );
    }
    return (await res.json()) as ModelClassesResponse;
  }
}
