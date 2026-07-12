/**
 * Per-agent tool-token provider (Phase 3 item 0c).
 *
 * After the tool gateway's audience flip, an agent no longer presents its
 * step's delegated token (audience `acp:agent:{id}`) at the gateway. Instead
 * it exchanges that token — using its OWN client credentials (a second,
 * independent secret) — for one bound to `acp:tools` (RFC 8693). The
 * exchange is same-actor narrowing: the acting party stays the agent, the
 * delegation chain (and the broker-minted `brokered` grounds) ride through
 * verbatim, scopes only narrow. A stolen delegated step token replayed at
 * the gateway now opens nothing — converting it needs the agent secret.
 *
 * Reuses the SDK's `TokenExchanger` (the same one the Retriever uses toward
 * `acp:knowledge`) so there is one exchange implementation, error mapping
 * included: a 4xx from the token service is a PolicyDenied, a network fault
 * is Retryable (Temporal's retry policy is the v0 backoff).
 */

import { CapabilityError, ErrorClass, TokenExchanger } from '@acp/agent-sdk';

/** The single, exact audience every governed tool call is bound to. */
export const TOOLS_AUDIENCE = 'acp:tools';

/**
 * Exchanges a step's delegated token for an `acp:tools` token. Given to
 * `McpToolClient`; called once per tool call.
 */
export type ToolTokenProvider = (delegatedToken: string) => Promise<string>;

export interface ToolTokenProviderOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Test seam — same shape as the SDK exchanger's fetch injection point. */
  fetchImpl?: typeof fetch;
}

export function toolTokenProvider(options: ToolTokenProviderOptions): ToolTokenProvider {
  const exchanger = new TokenExchanger({
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  return async (delegatedToken: string): Promise<string> => {
    try {
      return await exchanger.exchange(delegatedToken, TOOLS_AUDIENCE);
    } catch (err) {
      // TokenExchanger already maps a token-service 4xx to PolicyDenied;
      // a thrown fetch (DNS, connection reset, timeout) surfaces raw — map
      // it to Retryable so a token-service blip becomes a Temporal retry,
      // never a permanent failure.
      if (err instanceof CapabilityError) throw err;
      throw new CapabilityError(
        ErrorClass.Retryable,
        `tool token exchange unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
