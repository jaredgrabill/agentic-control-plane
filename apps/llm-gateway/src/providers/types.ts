/**
 * The provider adapter seam. Adapters translate one validated prompt into
 * one upstream completion and surface every failure as a typed
 * ProviderFault — the failover loop in core.ts decides retry/fail-over/
 * refuse from the fault kind alone, never from message sniffing.
 */

import type { CompletionUsage } from '@acp/llm-client';
import type { ValidatedPrompt } from '../prompt.js';

export interface ProviderRequest {
  prompt: ValidatedPrompt;
  maxTokens: number;
  temperature: number;
  /** Aborted when the per-attempt timeout or the overall deadline fires. */
  signal: AbortSignal;
}

export interface ProviderCompletion {
  text: string;
  usage: CompletionUsage;
}

/**
 * Closed fault vocabulary:
 *  - rate_limited / server / timeout / network → retry, then fail over
 *  - upstream_auth → fail over immediately (retrying a bad key is noise)
 *  - invalid_input → refuse the call (no failover — the request is wrong)
 */
export type ProviderFaultKind =
  'rate_limited' | 'server' | 'timeout' | 'network' | 'upstream_auth' | 'invalid_input';

export class ProviderFault extends Error {
  readonly kind: ProviderFaultKind;
  readonly retryAfterS: number | undefined;

  constructor(kind: ProviderFaultKind, message: string, retryAfterS?: number) {
    super(message);
    this.name = 'ProviderFault';
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }
}

export interface ProviderAdapter {
  complete(model: string, request: ProviderRequest): Promise<ProviderCompletion>;
}
