import { auditEvent as auditEventParser, type AgentCard, type AuditEvent } from '@acp/protocol';
import { scopesOf, type AuditPublisher, type Logger, type PlatformClaims } from '@acp/service-kit';
import type { ControlActivities } from './types.js';

export interface ControlDeps {
  registryUrl: string;
  policyUrl: string;
  tokenUrl: string;
  /** client_credentials for the orchestrator's own platform identity. */
  clientId: string;
  clientSecret: string;
  /** Verifies the forwarded subject token before its scopes reach Cedar. */
  verifier: { verify(token: string, audience: string): Promise<PlatformClaims> };
  audit: AuditPublisher | { publish(event: AuditEvent): Promise<void> };
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Control-plane activities: every effectful step the workflows need.
 * Failures throw with operator-actionable messages; Temporal owns retries.
 */
export function createControlActivities(deps: ControlDeps): ControlActivities {
  const doFetch = deps.fetchImpl ?? fetch;

  /** Service token for calling other control-plane services, fetched per call (≤15min TTL). */
  async function serviceToken(audience: string, scope: string): Promise<string> {
    const res = await doFetch(`${deps.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        audience,
        scope,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `token service refused client_credentials for ${audience}: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  return {
    async discoverAgent(capability, tenant): Promise<AgentCard | null> {
      const token = await serviceToken('acp:registry', 'registry:read');
      const res = await doFetch(
        `${deps.registryUrl}/v1/agents?capability=${encodeURIComponent(capability)}&state=active`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        throw new Error(`registry discovery failed: ${res.status} ${await res.text()}`);
      }
      const { agents } = (await res.json()) as { agents: AgentCard[] };
      // v0 selection: first active match. Weighted/semantic ranking is
      // Phase 2 (Discovery v1). Tenant visibility is a policy question the
      // authorizeDelegation step settles; the registry is platform-scoped.
      void tenant;
      return agents[0] ?? null;
    },

    async authorizeDelegation(input) {
      // Real verification, not decode-and-hope: the subject token was
      // issued for the gateway audience and its scopes are what the
      // principal actually holds.
      const subject = await deps.verifier.verify(input.subjectToken, 'acp:gateway');
      const token = await serviceToken('acp:policy', 'policy:decide');
      const capability = input.agent.manifest.capabilities.find((c) => c.name === input.capability);
      const res = await doFetch(`${deps.policyUrl}/v1/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          principal: {
            type: input.principal.startsWith('agent:') ? 'Agent' : 'User',
            id: input.principal,
            attrs: { tenant: input.tenant },
          },
          action: 'delegate',
          resource: {
            type: 'Agent',
            id: input.agent.manifest.id,
            attrs: { tenant: input.tenant },
          },
          context: {
            risk: capability?.risk ?? 'R3',
            scopes: scopesOf(subject),
            requested_scopes: input.requestedScopes,
            tenant: input.tenant,
            capability: input.capability,
          },
          reason: { task_id: input.taskId, step_id: input.stepId, tenant: input.tenant },
        }),
      });
      if (!res.ok) {
        throw new Error(`policy service failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as Awaited<ReturnType<ControlActivities['authorizeDelegation']>>;
    },

    async exchangeToken(input) {
      // Two hops so the act chain records what actually happened:
      // user → orchestrator (this service takes custody of the task),
      // then user → orchestrator → agent (the agent acts on the step).
      const exchange = async (
        subjectToken: string,
        audience: string,
        actor?: string,
        scope?: string,
      ) => {
        const res = await doFetch(`${deps.tokenUrl}/v1/token/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            client_id: deps.clientId,
            client_secret: deps.clientSecret,
            subject_token: subjectToken,
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            audience,
            ...(scope === undefined ? {} : { scope }),
            ...(actor === undefined ? {} : { actor }),
          }),
        });
        if (!res.ok) {
          throw new Error(
            `token exchange for ${audience} failed: ${res.status} ${await res.text()}`,
          );
        }
        return ((await res.json()) as { access_token: string }).access_token;
      };

      const orchestratorToken = await exchange(input.subjectToken, 'acp:orchestrator');
      const agentToken = await exchange(
        orchestratorToken,
        `acp:agent:${input.agent.manifest.id}`,
        `agent:${input.agent.manifest.id}@${input.agent.version}`,
        input.scopes.join(' '),
      );
      return { token: agentToken };
    },

    async emitAudit(event) {
      await deps.audit.publish(auditEventParser.parse(event));
    },
  };
}
