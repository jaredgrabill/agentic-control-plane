/**
 * The hermetic dev provider (family dev-llm): deterministic completions
 * for dev/CI so no real provider is ever exercised there, plus scripted
 * failure models for the fault-injection suites. Prompt caching is
 * SIMULATED: the first sighting of a static prefix bills
 * cache_creation_input_tokens, a repeat bills cache_read_input_tokens —
 * so cache accounting is observable end to end without a provider.
 */

import { createHash } from 'node:crypto';
import {
  ProviderFault,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderRequest,
} from './types.js';
import { estimateTokens, stableStringify } from '../prompt.js';

export const DEV_ECHO_MODEL = 'dev-echo@1';
export const DEV_FAIL_429_MODEL = 'dev-fail-429@1';
export const DEV_FAIL_500_MODEL = 'dev-fail-500@1';

/** Evals and judge fixtures script exact outputs through the data itself. */
export const DEV_DIRECTIVE = '[[dev-llm]] ';

const ECHO_PREVIEW_CHARS = 160;
const MAX_TRACKED_PREFIXES = 1024;

export class DevProvider implements ProviderAdapter {
  /** Insertion-ordered — doubles as a bounded LRU of seen prefixes. */
  private readonly seenPrefixes = new Set<string>();

  complete(model: string, request: ProviderRequest): Promise<ProviderCompletion> {
    switch (model) {
      case DEV_FAIL_429_MODEL:
        return Promise.reject(
          new ProviderFault('rate_limited', `${model} always answers 429 (scripted)`, 1),
        );
      case DEV_FAIL_500_MODEL:
        return Promise.reject(new ProviderFault('server', `${model} always faults (scripted)`));
      case DEV_ECHO_MODEL:
        return Promise.resolve(this.echo(request));
      default:
        return Promise.reject(
          new ProviderFault('invalid_input', `dev provider has no model ${model}`),
        );
    }
  }

  private echo(request: ProviderRequest): ProviderCompletion {
    const { prompt } = request;
    const variableText = prompt.variableBlocks.map((b) => b.text).join('\n');

    const directiveLine = variableText.split('\n').find((line) => line.startsWith(DEV_DIRECTIVE));
    const text =
      directiveLine !== undefined
        ? directiveLine.slice(DEV_DIRECTIVE.length)
        : `dev-llm@1 sha256:${fingerprint(prompt.blocks)} ${variableText.slice(0, ECHO_PREVIEW_CHARS)}`;

    let cacheRead = 0;
    let cacheCreation = 0;
    if (prompt.staticBlocks.length > 0) {
      if (this.seenPrefixes.has(prompt.prefixDigest)) {
        cacheRead = prompt.staticTokensEstimate;
        // Refresh recency so hot prefixes survive the LRU cap.
        this.seenPrefixes.delete(prompt.prefixDigest);
      } else {
        cacheCreation = prompt.staticTokensEstimate;
      }
      this.seenPrefixes.add(prompt.prefixDigest);
      if (this.seenPrefixes.size > MAX_TRACKED_PREFIXES) {
        const oldest = this.seenPrefixes.values().next().value;
        if (oldest !== undefined) this.seenPrefixes.delete(oldest);
      }
    }

    return {
      text,
      usage: {
        input_tokens: prompt.variableTokensEstimate,
        output_tokens: Math.max(1, estimateTokens(text)),
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    };
  }
}

function fingerprint(blocks: unknown): string {
  return createHash('sha256').update(stableStringify(blocks)).digest('hex').slice(0, 12);
}
