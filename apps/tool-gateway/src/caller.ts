/**
 * Who is calling the gateway. The delegated token's claims are resolved
 * into a Caller once per request: the acting principal (act.sub ?? sub)
 * drives Cedar, the raw token is the subject for knowledge's per-call
 * exchange, and the audience↔actor consistency check refuses tokens whose
 * agent audience does not match the actor actually named in the chain.
 */

import { AuthError, type PlatformClaims, scopesOf } from '@acp/service-kit';

export const TOOLS_AUDIENCE = 'acp:tools';
const AGENT_AUDIENCE_PREFIX = 'acp:agent:';

/**
 * v1 audience acceptance (documented compromise, tightened to acp:tools in
 * Phase 3): the step's delegated token is minted for the AGENT's audience,
 * and re-exchanging it toward acp:tools would force token-service
 * credentials onto every TS agent for no authz gain — the delegated token
 * already carries the narrowed scopes and the full act chain, which are
 * the only authorization inputs. Stolen bare service tokens still fail the
 * aud↔act.sub consistency check in resolveCaller().
 */
export function acceptToolsAudience(aud: string): boolean {
  return aud === TOOLS_AUDIENCE || aud.startsWith(AGENT_AUDIENCE_PREFIX);
}

export const AUDIENCE_DESCRIPTION = 'acp:tools or acp:agent:{id}';

export interface Caller {
  /** Original principal (JWT sub) — the user or service the chain started from. */
  sub: string;
  /** Acting principal (act.sub ?? sub) — who Cedar decides for. */
  principal: string;
  entityType: 'Agent' | 'User' | 'Service';
  tenant: string;
  scopes: string[];
  /** Agent id, when the caller acts as one — the kill-switch key. */
  agentId?: string | undefined;
  /** The raw delegated JWT — subject_token for the knowledge exchange. */
  token: string;
  claims: PlatformClaims;
}

export function resolveCaller(claims: PlatformClaims, rawToken: string): Caller {
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const principal = claims.act?.sub ?? claims.sub;

  let agentId: string | undefined;
  if (aud.startsWith(AGENT_AUDIENCE_PREFIX)) {
    agentId = aud.slice(AGENT_AUDIENCE_PREFIX.length);
    // aud↔act.sub consistency: an acp:agent:{id} token must actually be
    // acting as agent:{id}@… — a bare service token re-aimed at an agent
    // audience, or a token whose chain names a different agent, is refused.
    if (claims.act?.sub.startsWith(`agent:${agentId}@`) !== true) {
      throw new AuthError(
        `token audience ${aud} does not match its actor ` +
          `${JSON.stringify(claims.act?.sub)} — expected act.sub agent:${agentId}@{version}`,
        401,
      );
    }
  } else if (principal.startsWith('agent:')) {
    // acp:tools tokens presented by an agent principal: derive the id so
    // the kill switch still applies.
    agentId = principal.slice('agent:'.length).split('@')[0];
  }

  return {
    sub: claims.sub,
    principal,
    entityType: entityTypeOf(principal),
    tenant: claims.tenant,
    scopes: scopesOf(claims),
    ...(agentId !== undefined ? { agentId } : {}),
    token: rawToken,
    claims,
  };
}

function entityTypeOf(principal: string): 'Agent' | 'User' | 'Service' {
  if (principal.startsWith('agent:')) return 'Agent';
  if (principal.startsWith('svc:')) return 'Service';
  return 'User';
}
