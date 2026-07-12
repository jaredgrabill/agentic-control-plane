/**
 * Records an accepted baseline on the registry's agent card:
 * client_credentials token (audience acp:registry, scope registry:write —
 * the existing CI grant, no new scope) then PUT the baseline. The registry
 * is the system of record consumers read; the committed baseline.json stays
 * CI's source of truth.
 */

import { agentCard, type AgentCard, type EvalBaseline } from '@acp/protocol';

export interface RecordOptions {
  registryUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  baseline: EvalBaseline;
  fetchImpl?: typeof fetch;
}

export async function recordBaseline(options: RecordOptions): Promise<AgentCard> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const tokenRes = await fetchImpl(`${options.tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      audience: 'acp:registry',
      scope: 'registry:write',
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token request failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const res = await fetchImpl(
    `${options.registryUrl}/v1/agents/${options.baseline.agent_id}/baseline`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify(options.baseline),
    },
  );
  if (!res.ok) {
    throw new Error(`baseline record failed (${res.status}): ${await res.text()}`);
  }
  return agentCard.parse(await res.json());
}
