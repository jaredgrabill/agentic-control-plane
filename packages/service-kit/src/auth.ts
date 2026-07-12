import type { DelegationLink } from '@acp/protocol';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

/** Nested RFC 8693 actor claim: `act.sub` is the current actor, inner `act` the one before it. */
export interface ActClaim {
  sub: string;
  act?: ActClaim;
}

/**
 * Broker-minted grounds tying a token back to the task intake that
 * authorized it (ADR-0007). Only `TokenIssuer.delegate()` sets it; the
 * exchange path propagates it verbatim across same-actor narrowing
 * exchanges (SPRINT cross-item contract, item-3 D2) so an agent's per-call
 * acp:tools token still carries the task binding downstream PEPs check.
 */
export interface BrokeredClaim {
  task_id: string;
  subject_jti?: string;
  verified_at: string;
}

/**
 * Signed human-approval grounds (Phase 3 item 1). Only
 * `TokenIssuer.delegate()` sets it — the orchestrator brokering a step token
 * AFTER an ApprovalWorkflow granted the gated delegation. Rides verbatim
 * across the agent's same-actor acp:tools exchange (SPRINT cross-item
 * contract) so the tool gateway can bind it to the exact step. `subject_digest`
 * is the sha256 over the full approval subject the approver saw — the tie
 * between what was displayed, what was decided, and what executes.
 */
export interface ApprovalClaim {
  /** approval_id: the ApprovalWorkflow instance the decision belongs to. */
  id: string;
  decision_id: string;
  /** The verified approver principal (claims.sub of the deciding JWT), never the subject. */
  approver: string;
  step_id: string;
  capability: string;
  subject_digest: string;
}

/**
 * Signed compensation grounds (Phase 3 item 2). Only
 * `TokenIssuer.delegate()` sets it — the orchestrator brokering a compensator
 * step token during a saga unwind. Rides verbatim across the agent's
 * same-actor acp:tools exchange (SPRINT cross-item contract) so item 3's
 * tool-gateway risk-class PEP reads it as `context.compensation` and does not
 * re-gate the compensator's R2 tool call. The compensator is pre-authorized by
 * the original write's approval; this claim is the token-layer defense-in-depth
 * proving the call is an unwind, not agent-elected. `approval_id`/`approver`
 * (when present) join the compensator to that original approval for auditors.
 */
export interface CompensationClaim {
  /** The step_id of the original write this dispatch compensates. */
  original_step_id: string;
  /** The capability of the original write (e.g. change.submit). */
  original_capability: string;
  /** The approval that authorized the original write, if it was gated. */
  approval_id?: string;
  /** The approver of the original write, if it was gated. */
  approver?: string;
}

/**
 * Signed capability grounds (Phase 3 item 3). Only `TokenIssuer.delegate()`
 * sets it — the orchestrator brokering a step token names the exact capability
 * executing and its declared risk class. Rides verbatim across the agent's
 * same-actor acp:tools exchange (SPRINT cross-item contract) so the tool
 * gateway's risk-class PEP reads the risk from a VERIFIED claim, not from a
 * caller-supplied header or a registry lookup that cannot know which
 * capability is running. A tool whose risk exceeds `risk` is refused
 * structurally (design §D3). Absent (an unbrokered token, or one that lost the
 * claim across an actor change) is treated as R0 context — fail-safe: only R0
 * reads pass, every R1+/R2 tool is refused.
 */
export interface CapabilityClaim {
  /** The capability name executing this step (e.g. change.submit). */
  name: string;
  /** The declared risk class of that capability: R0 | R1 | R2 | R3. */
  risk: string;
}

/**
 * Signed deployment grounds (Phase 3 item 4). Only `TokenIssuer.delegate()`
 * sets it — and only the orchestrator's ShadowStepWorkflow, when it brokers a
 * SHADOW step token. Rides verbatim across the shadow agent's same-actor
 * acp:tools exchange (SPRINT cross-item contract) so the tool gateway reads
 * `deployment.mode === 'shadow'` from a VERIFIED claim and SUPPRESSES side
 * effects (executes R0 reads, refuses R1+ writes and records what would have
 * been done). A caller cannot forge it: issue()/exchange() reject a
 * body-supplied deployment (400), and an actor-appending exchange drops it.
 */
export interface DeploymentClaim {
  /** The deployment mode; v0 is 'shadow' only (side-effect suppression). */
  mode: string;
}

export interface PlatformClaims extends JWTPayload {
  sub: string;
  tenant: string;
  roles: string[];
  /** Space-delimited per RFC 8693 / OAuth. */
  scope: string;
  act?: ActClaim;
  /** Present only on broker-delegated tokens and their same-actor exchanges. */
  brokered?: BrokeredClaim;
  /** Present only on broker-delegated tokens minted after an approval, and their same-actor exchanges. */
  approval?: ApprovalClaim;
  /** Present only on broker-delegated compensator tokens, and their same-actor exchanges. */
  compensation?: CompensationClaim;
  /** Present only on broker-delegated step tokens naming the executing capability, and their same-actor exchanges. */
  capability?: CapabilityClaim;
  /** Present only on broker-delegated SHADOW step tokens, and their same-actor exchanges. */
  deployment?: DeploymentClaim;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

type JwksSource = { jwksUrl: string } | { jwks: JSONWebKeySet };

/**
 * Local JWT verification against the Token Service JWKS — no per-request
 * calls to anything (ADR-0004): the key set is fetched/cached by jose and
 * refreshed on rotation.
 */
export class JwtVerifier {
  private readonly keySet: ReturnType<typeof createLocalJWKSet>;
  private readonly issuer: string;

  constructor(source: JwksSource, issuer: string) {
    this.issuer = issuer;
    this.keySet =
      'jwks' in source
        ? createLocalJWKSet(source.jwks)
        : createRemoteJWKSet(new URL(source.jwksUrl));
  }

  /** Verifies signature, expiry, issuer, and audience, then the platform claim shape. */
  async verify(token: string, expectedAudience: string): Promise<PlatformClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keySet, {
        issuer: this.issuer,
        audience: expectedAudience,
      }));
    } catch (err) {
      throw new AuthError(
        `token verification failed for audience ${JSON.stringify(expectedAudience)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return assertPlatformClaims(payload);
  }

  /**
   * Like verify(), but the audience is checked against a caller-supplied
   * predicate instead of a single expected value — for PEPs that accept a
   * family of audiences (the tool gateway takes `acp:tools` or any
   * `acp:agent:{id}`). The token must carry exactly one string audience;
   * multi-audience tokens are refused because a predicate over an array
   * would silently widen what the token is good for.
   */
  async verifyWithAudience(
    token: string,
    accept: (aud: string) => boolean,
    description: string,
  ): Promise<PlatformClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keySet, { issuer: this.issuer }));
    } catch (err) {
      throw new AuthError(
        `token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof payload.aud !== 'string' || !accept(payload.aud)) {
      throw new AuthError(`token audience not accepted: ${description}`, 401);
    }
    return assertPlatformClaims(payload);
  }
}

export function assertPlatformClaims(payload: JWTPayload): PlatformClaims {
  const { sub, tenant, roles, scope } = payload as Partial<PlatformClaims>;
  if (typeof sub !== 'string' || sub === '') {
    throw new AuthError('token has no sub claim');
  }
  if (typeof tenant !== 'string' || tenant === '') {
    throw new AuthError(`token for ${sub} has no tenant claim`);
  }
  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) {
    throw new AuthError(`token for ${sub} has no roles claim`);
  }
  if (typeof scope !== 'string') {
    throw new AuthError(`token for ${sub} has no scope claim`);
  }
  return payload as PlatformClaims;
}

export function scopesOf(claims: Pick<PlatformClaims, 'scope'>): string[] {
  return claims.scope === '' ? [] : claims.scope.split(' ');
}

/**
 * Delegation always narrows: the result is the intersection, never the
 * union (ADR-0004). Order follows the requested scopes for stable output.
 */
export function intersectScopes(requested: string[], held: string[]): string[] {
  const heldSet = new Set(held);
  return requested.filter((s) => heldSet.has(s));
}

/**
 * Reconstructs the delegation chain from nested act claims, outermost
 * (original principal) first — the shape audit records require.
 */
export function delegationChain(claims: Pick<PlatformClaims, 'sub' | 'act'>): DelegationLink[] {
  const actors: string[] = [];
  for (let act = claims.act; act !== undefined; act = act.act) {
    actors.push(act.sub);
  }
  actors.reverse();
  return [claims.sub, ...actors].map((sub) => ({ sub }));
}
