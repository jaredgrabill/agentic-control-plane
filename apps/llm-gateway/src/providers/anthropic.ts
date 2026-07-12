/**
 * Anthropic Messages API adapter. Never exercised in dev/CI (the dev
 * provider owns those profiles) — unit tests drive it against a mocked
 * fetch. Prompt-caching layout: when the static prefix is estimated at
 * ≥1024 tokens, the LAST static block gets an ephemeral cache_control
 * breakpoint, so the provider caches exactly the prefix the wire shape
 * already guarantees stable.
 */

import {
  ProviderFault,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderRequest,
} from './types.js';
import type { PromptBlock } from '@acp/llm-client';

export const ANTHROPIC_VERSION = '2023-06-01';
/** Provider-documented minimum cacheable prefix (Sonnet-class models). */
export const CACHE_CONTROL_MIN_TOKENS = 1024;

interface ContentPart {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ProviderAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(model: string, request: ProviderRequest): Promise<ProviderCompletion> {
    const body = buildRequestBody(model, request);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal.aborted) {
        throw new ProviderFault('timeout', 'anthropic request aborted by the attempt deadline');
      }
      throw new ProviderFault(
        'network',
        `anthropic unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw await faultFor(res);
    }
    const payload = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      usage?: AnthropicUsage;
    };
    const text = (payload.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const usage = payload.usage ?? {};
    return {
      text,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/**
 * Static blocks keep their assembled position: system-role statics land in
 * the top-level `system` array, the rest open the messages list, and the
 * variable tail follows — with the cache breakpoint on the last static
 * block wherever it lives.
 */
export function buildRequestBody(model: string, request: ProviderRequest): Record<string, unknown> {
  const { prompt } = request;
  const markCache =
    prompt.staticBlocks.length > 0 && prompt.staticTokensEstimate >= CACHE_CONTROL_MIN_TOKENS;

  const system: ContentPart[] = [];
  const messages: { role: 'user' | 'assistant'; content: ContentPart[] }[] = [];

  const push = (block: PromptBlock, isLastStatic: boolean): void => {
    const part: ContentPart = { type: 'text', text: block.text };
    if (isLastStatic && markCache) part.cache_control = { type: 'ephemeral' };
    if (block.role === 'system') {
      system.push(part);
    } else {
      messages.push({ role: block.role, content: [part] });
    }
  };

  prompt.staticBlocks.forEach((block, index) => {
    push(block, index === prompt.staticBlocks.length - 1);
  });
  for (const block of prompt.variableBlocks) {
    if (block.role === 'system') {
      // Anthropic has no in-thread system turn; a variable system block
      // rides as a user turn so its content still reaches the model.
      messages.push({ role: 'user', content: [{ type: 'text', text: block.text }] });
    } else {
      messages.push({ role: block.role, content: [{ type: 'text', text: block.text }] });
    }
  }

  return {
    model,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    ...(system.length > 0 ? { system } : {}),
    messages,
  };
}

async function faultFor(res: Response): Promise<ProviderFault> {
  const detail = await res
    .json()
    .then((body: unknown) => (body as { error?: { message?: string } }).error?.message)
    .catch(() => undefined);
  const message = `anthropic answered ${res.status}${detail !== undefined ? `: ${detail}` : ''}`;
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return new ProviderFault(
      'rate_limited',
      message,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1,
    );
  }
  if (res.status === 401 || res.status === 403) return new ProviderFault('upstream_auth', message);
  if (res.status === 408) return new ProviderFault('timeout', message);
  // 529 (overloaded) and every 5xx are transient server faults.
  if (res.status >= 500) return new ProviderFault('server', message);
  return new ProviderFault('invalid_input', message);
}
