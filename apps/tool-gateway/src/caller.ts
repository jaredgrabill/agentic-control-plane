/**
 * Who is calling the gateway. The presented token's claims are resolved
 * into a Caller once per request: the acting principal (act.sub ?? sub)
 * drives Cedar, and — for Agent principals — the delegation chain must
 * terminate at the broker (svc:orchestrator), so an agent-audience token
 * fabricated from an agent secret and a stolen subject token opens nothing.
 *
 * Phase 3 item 0c: the gateway accepts exactly one audience, acp:tools.
 * Agents no longer present their step's delegated token (audience
 * acp:agent:{id}); they exchange it for an acp:tools token using their own
 * client secret first (packages/tool-client toolTokenProvider). The old
 * acp:agent:* acceptance and the aud↔act.sub consistency check it needed
 * are gone — a bare acp:agent token now fails at the door.
 */

import { AuthError, type ActClaim, type PlatformClaims, scopesOf } from '@acp/service-kit';

export const TOOLS_AUDIENCE = 'acp:tools';

/** The only principal ADR-0004/0007 permits at the root of a delegation chain. */
const ORCHESTRATOR_PRINCIPAL = 'svc:orchestrator';

/**
 * acp:tools and nothing else (Phase 3 flip; debt #2 closed). One exact
 * audience string at the PEP — `verifyWithAudience` still refuses
 * multi-audience tokens, so this is a single-string equality check.
 */
export function acceptToolsAudience(aud: string): boolean {
  return aud === TOOLS_AUDIENCE;
}

export const AUDIENCE_DESCRIPTION = 'acp:tools';

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
  /** The raw acp:tools JWT — subject_token for the knowledge exchange. */
  token: string;
  claims: PlatformClaims;
}

export function resolveCaller(claims: PlatformClaims, rawToken: string): Caller {
  const principal = claims.act?.sub ?? claims.sub;

  let agentId: string | undefined;
  if (principal.startsWith('agent:')) {
    // Orchestrator-chain check: an Agent principal only reaches the gateway
    // inside a task the broker delegated. The chain (nested act claims) must
    // bottom out at svc:orchestrator — the sole broker (ADR-0007). This
    // refuses an agent-secret + stolen-subject-token fabrication that names
    // an agent actor but has no orchestrator hop underneath it. Cedar still
    // makes the real authorization decision on top of this structural gate.
    if (!chainTerminatesAtOrchestrator(claims.act)) {
      throw new AuthError(
        `agent-principal token for ${principal} has no delegation chain terminating at ` +
          `${ORCHESTRATOR_PRINCIPAL} — a tools token acting as an agent must originate from a ` +
          'broker-delegated task',
        401,
      );
    }
    // Derive the id so the kill switch keys correctly.
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

/** Walks the nested act chain to its innermost actor and checks it is the broker. */
function chainTerminatesAtOrchestrator(act: ActClaim | undefined): boolean {
  if (act === undefined) return false;
  let innermost = act;
  while (innermost.act !== undefined) {
    innermost = innermost.act;
  }
  return innermost.sub === ORCHESTRATOR_PRINCIPAL;
}

function entityTypeOf(principal: string): 'Agent' | 'User' | 'Service' {
  if (principal.startsWith('agent:')) return 'Agent';
  if (principal.startsWith('svc:')) return 'Service';
  return 'User';
}
