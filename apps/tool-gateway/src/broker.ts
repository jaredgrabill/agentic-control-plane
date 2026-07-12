/**
 * Credential brokering: the gateway holds the upstream credentials so
 * agents never see them (paved-road: "the gateway replaces the URL, not
 * the interface" — and it also replaces the secret).
 *
 * Two dev-profile modes:
 * - static-headers: configured header values (env-expanded at startup) are
 *   injected verbatim — the mock servers' stand-in for vaulted API keys.
 * - token-exchange: RFC 8693 exchange per call as svc-tool-gateway. The
 *   caller's delegated token is the subject, the audience is rebound to
 *   the upstream (acp:knowledge), scopes intersect down to the entry's
 *   list, and the actor is PRESERVED — the upstream's own PEP evaluates
 *   the true principal, not the gateway.
 *
 * Phase 3+ (stated, not built): vault-backed secrets and rotation,
 * per-tenant credentials, mTLS/SPIFFE service identity, R2
 * require-approval at this PEP, shadow-mode suppression, exchange-result
 * caching. Per-call exchange costs two extra hops today — accepted.
 */

import type { Caller } from './caller.js';
import type { ToolServerEntry } from './config.js';

export interface Correlation {
  taskId?: string | undefined;
  stepId?: string | undefined;
}

export interface CredentialBroker {
  headersFor(
    entry: ToolServerEntry,
    caller: Caller,
    corr: Correlation,
  ): Promise<Record<string, string>>;
}

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

export class DevCredentialBroker implements CredentialBroker {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async headersFor(
    entry: ToolServerEntry,
    caller: Caller,
    corr: Correlation,
  ): Promise<Record<string, string>> {
    const correlation = {
      ...(corr.taskId !== undefined ? { 'x-acp-task-id': corr.taskId } : {}),
      ...(corr.stepId !== undefined ? { 'x-acp-step-id': corr.stepId } : {}),
    };
    if (entry.auth.mode === 'static-headers') {
      return { ...entry.auth.headers, ...correlation };
    }

    const res = await this.fetchImpl(`${this.options.tokenUrl}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: TOKEN_EXCHANGE_GRANT,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        subject_token: caller.token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        audience: entry.auth.audience,
        scope: entry.auth.scope.join(' '),
        // Actor preserved: the upstream PEP must see the true principal.
        actor: caller.principal,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `credential broker could not exchange the caller token for ${entry.id}: ` +
          `${res.status} ${await res.text()}`,
      );
    }
    const { access_token } = (await res.json()) as { access_token: string };
    return { authorization: `Bearer ${access_token}`, ...correlation };
  }
}
