/**
 * Who is calling the LLM gateway. Mirrors the tool gateway's caller
 * resolution: the acting principal (act.sub ?? sub) drives enforcement,
 * and the audience↔actor consistency check refuses tokens whose agent
 * audience does not match the actor actually named in the chain.
 *
 * Two doors in v1:
 *   - `acp:llm` service tokens (judge harness, planner, synthesis, CI)
 *     carrying the `llm:invoke` scope — any model class.
 *   - `acp:agent:{id}` delegated step tokens — the class must be in the
 *     agent's manifest `models.allowed` (checked in core via the registry).
 */

import { AuthError, scopesOf, type PlatformClaims } from '@acp/service-kit';

export const LLM_AUDIENCE = 'acp:llm';
export const INVOKE_SCOPE = 'llm:invoke';
const AGENT_AUDIENCE_PREFIX = 'acp:agent:';

export function acceptLlmAudience(aud: string): boolean {
  return aud === LLM_AUDIENCE || aud.startsWith(AGENT_AUDIENCE_PREFIX);
}

export const AUDIENCE_DESCRIPTION = 'acp:llm or acp:agent:{id}';

export interface Caller {
  /** Original principal (JWT sub) — the user or service the chain started from. */
  sub: string;
  /** Acting principal (act.sub ?? sub). */
  principal: string;
  tenant: string;
  scopes: string[];
  /** Agent id, when the caller acts as one — kill-switch and allowlist key. */
  agentId?: string | undefined;
  claims: PlatformClaims;
}

export function resolveCaller(claims: PlatformClaims): Caller {
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
  } else {
    if (principal.startsWith('agent:')) {
      // acp:llm tokens presented by an agent principal: derive the id so
      // the kill switch and the model allowlist still apply.
      agentId = principal.slice('agent:'.length).split('@')[0];
    } else if (!scopesOf(claims).includes(INVOKE_SCOPE)) {
      // Service/user callers on the shared audience must hold llm:invoke.
      throw new AuthError(
        `token for ${claims.sub} lacks the ${INVOKE_SCOPE} scope required for ${LLM_AUDIENCE}`,
        401,
      );
    }
  }

  return {
    sub: claims.sub,
    principal,
    tenant: claims.tenant,
    scopes: scopesOf(claims),
    ...(agentId !== undefined ? { agentId } : {}),
    claims,
  };
}
