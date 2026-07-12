/**
 * HTTP Cedar PDP client: mints its own policy:decide token per decision
 * and POSTs the authorization request. Deliberately the same ~30 lines the
 * knowledge service inlines in its bootstrap (apps/knowledge/src/main.ts)
 * rather than a premature refactor — when a third service needs it, the
 * shape moves into @acp/service-kit.
 */

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require-approval';
  bundle_version: string;
  determining_policies: string[];
}

export interface PolicyClient {
  authorize(request: {
    principal: { type: string; id: string; attrs: Record<string, unknown> };
    action: string;
    resource: { type: string; id: string; attrs: Record<string, unknown> };
    context: Record<string, unknown>;
    reason?: Record<string, unknown>;
  }): Promise<PolicyDecision>;
}

export class HttpPolicyClient implements PolicyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      policyUrl: string;
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async authorize(request: Parameters<PolicyClient['authorize']>[0]): Promise<PolicyDecision> {
    const tokenRes = await this.fetchImpl(`${this.options.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: 'acp:policy',
        scope: 'policy:decide',
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`token service refused tool-gateway client: ${tokenRes.status}`);
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const res = await this.fetchImpl(`${this.options.policyUrl}/v1/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`policy service failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as PolicyDecision;
  }
}
