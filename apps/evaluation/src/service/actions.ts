import { agentManifest, type AgentCard } from '@acp/protocol';
import type { Logger } from '@acp/service-kit';
import type { AgentMeta, LadderActions } from './app.js';

export interface ActionClientDeps {
  tokenUrl: string;
  registryUrl: string;
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
  sloDefault: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * The eval service's outbound client for the ladder's real mechanisms and for
 * SLO/owner resolution. It mints short-lived audience-bound service tokens per
 * call (≤15min TTL) — the eval service holds no long-lived downstream creds.
 */
export function createActionClients(deps: ActionClientDeps): {
  actions: LadderActions;
  agentMeta: (agentId: string) => Promise<AgentMeta>;
} {
  const doFetch = deps.fetchImpl ?? fetch;

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
        `token service refused ${audience}/${scope}: ${res.status} ${await res.text()}`,
      );
    }
    return ((await res.json()) as { access_token: string }).access_token;
  }

  const actions: LadderActions = {
    async abortDeployment(agentId) {
      const token = await serviceToken('acp:gateway', 'deploy:write');
      const res = await doFetch(
        `${deps.gatewayUrl}/v1/deployments/${encodeURIComponent(agentId)}/abort`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      );
      // 404 (no running deployment) and 409 (already terminal) are benign — the
      // severe rung's intent (no in-flight deployment survives) is satisfied.
      if (!res.ok && res.status !== 404 && res.status !== 409) {
        throw new Error(`deployment abort failed: ${res.status} ${await res.text()}`);
      }
      deps.logger.warn({ agent_id: agentId, status: res.status }, 'ladder: aborted deployment');
    },

    async suspendAgent(agentId, reason) {
      // Narrow registry:suspend scope — valid ONLY on the *→suspended edge.
      const token = await serviceToken('acp:registry', 'registry:suspend');
      const res = await doFetch(
        `${deps.registryUrl}/v1/agents/${encodeURIComponent(agentId)}/state`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ state: 'suspended', reason }),
        },
      );
      if (!res.ok) {
        throw new Error(`agent suspend failed: ${res.status} ${await res.text()}`);
      }
      deps.logger.error({ agent_id: agentId, reason }, 'ladder: auto-suspended agent (SLO floor)');
    },
  };

  async function agentMeta(agentId: string): Promise<AgentMeta> {
    try {
      const token = await serviceToken('acp:registry', 'registry:read');
      const res = await doFetch(`${deps.registryUrl}/v1/agents/${encodeURIComponent(agentId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { slo: deps.sloDefault, owner: 'unknown' };
      const card = (await res.json()) as AgentCard;
      const manifest = agentManifest.parse(card.manifest);
      return {
        slo: manifest.sla?.quality_slo ?? deps.sloDefault,
        owner: manifest.owner,
      };
    } catch (err) {
      // SLO/owner resolution is best-effort — a registry blip must not stall
      // the enforcement pass. Fall back to the config default.
      deps.logger.warn({ err, agent_id: agentId }, 'agentMeta lookup failed — using SLO default');
      return { slo: deps.sloDefault, owner: 'unknown' };
    }
  }

  return { actions, agentMeta };
}
