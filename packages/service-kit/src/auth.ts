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

export interface PlatformClaims extends JWTPayload {
  sub: string;
  tenant: string;
  roles: string[];
  /** Space-delimited per RFC 8693 / OAuth. */
  scope: string;
  act?: ActClaim;
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
