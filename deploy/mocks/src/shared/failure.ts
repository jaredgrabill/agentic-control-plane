/**
 * Scripted failure modes so agent and gateway tests can exercise the typed
 * error paths deterministically. A directive arrives per request via the
 * `x-acp-mock-failure` header or a `?failure=` query parameter.
 *
 * Grammar: `rate_limited[:retry_after_s]`, `timeout[:ms]`, `partial`.
 */

import type { ToolEnvelope } from '@acp/tool-client';
import { fail } from './envelope.js';

export type FailureDirective =
  | { kind: 'rate_limited'; retryAfterS: number }
  | { kind: 'timeout'; ms: number }
  | { kind: 'partial' };

const DEFAULT_RETRY_AFTER_S = 1;
const DEFAULT_TIMEOUT_MS = 20_000;

export function parseFailureDirective(
  raw: string | undefined | null,
): FailureDirective | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // split() always yields at least one element; default just narrows the
  // noUncheckedIndexedAccess type so the switch stays non-union.
  const [kind = '', arg] = raw.split(':', 2);
  switch (kind) {
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterS: parseNumber(arg, DEFAULT_RETRY_AFTER_S, raw) };
    case 'timeout':
      return { kind: 'timeout', ms: parseNumber(arg, DEFAULT_TIMEOUT_MS, raw) };
    case 'partial':
      if (arg !== undefined) throw new Error(`unknown failure directive: ${raw}`);
      return { kind: 'partial' };
    default:
      throw new Error(`unknown failure directive: ${raw}`);
  }
}

function parseNumber(arg: string | undefined, fallback: number, raw: string): number {
  if (arg === undefined) return fallback;
  const value = Number(arg);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`unknown failure directive: ${raw}`);
  }
  return value;
}

/**
 * The pre-handler envelope override: rate_limited replaces the result
 * entirely; timeout is handled at the HTTP layer (see applyTimeout);
 * partial post-processes the envelope (see forcePartial).
 */
export function failureEnvelope(directive: FailureDirective | undefined): ToolEnvelope | undefined {
  if (directive?.kind !== 'rate_limited') return undefined;
  return fail(
    'rate_limited',
    `mock failure directive: rate limited — retry after ${directive.retryAfterS}s`,
    directive.retryAfterS,
  );
}

/** Marks a successful envelope partial (the `partial` directive). */
export function forcePartial(
  envelope: ToolEnvelope,
  directive: FailureDirective | undefined,
): ToolEnvelope {
  if (directive?.kind !== 'partial' || !envelope.ok) return envelope;
  return {
    ...envelope,
    partial: true,
    gaps: [...(envelope.gaps ?? []), 'mock failure directive: partial result forced'],
  };
}

/** Sleeps for the directive's duration before the request is handled. */
export async function applyTimeout(
  directive: FailureDirective | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (directive?.kind !== 'timeout') return;
  await sleep(directive.ms);
}
