import { randomUUID } from 'node:crypto';
import {
  AuthError,
  assertPlatformClaims,
  intersectScopes,
  scopesOf,
  type ActClaim,
  type PlatformClaims,
} from '@acp/service-kit';
import { SignJWT, createLocalJWKSet, jwtVerify } from 'jose';
import type { RegisteredClient } from './clients.js';
import { SIGNING_ALG, type KeyStore } from './keys.js';

/** ADR-0004: TTL ≤ 15 minutes, no exceptions — a captured credential is worth minutes, not months. */
export const MAX_TTL_SECONDS = 15 * 60;
export const DEFAULT_TTL_SECONDS = 10 * 60;

export interface IssueRequest {
  client: RegisteredClient;
  audience: string;
  scopes?: string[] | undefined;
  ttlSeconds?: number | undefined;
}

export interface ExchangeRequest {
  client: RegisteredClient;
  subjectToken: string;
  audience: string;
  scopes?: string[] | undefined;
  /**
   * Principal the new token acts as. Only platform-role clients (the
   * orchestrator delegating to agents) may set an actor other than their
   * own principal — an agent must not be able to impersonate another actor.
   */
  actor?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface IssuedToken {
  token: string;
  expiresIn: number;
  claims: PlatformClaims;
}

export class TokenIssuer {
  constructor(
    private readonly keys: KeyStore,
    private readonly issuer: string,
  ) {}

  private async sign(
    claims: Omit<PlatformClaims, 'iss' | 'iat' | 'exp' | 'jti'>,
    ttlSeconds: number,
  ): Promise<IssuedToken> {
    const ttl = clampTtl(ttlSeconds);
    const jwt = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: this.keys.current.kid })
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttl}s`)
      .sign(this.keys.current.privateKey);
    return {
      token: jwt,
      expiresIn: ttl,
      claims: { ...claims, iss: this.issuer } as PlatformClaims,
    };
  }

  /** client_credentials issuance: the token speaks for the client's registered principal. */
  async issue(request: IssueRequest): Promise<IssuedToken> {
    const requested = request.scopes ?? request.client.scopes;
    const outside = requested.filter((s) => !request.client.scopes.includes(s));
    if (outside.length > 0) {
      throw new AuthError(
        `client ${request.client.client_id} requested scopes outside its registration: ${outside.join(', ')}`,
        403,
      );
    }
    return this.sign(
      {
        sub: request.client.principal,
        aud: request.audience,
        tenant: request.client.tenant,
        roles: request.client.roles,
        scope: requested.join(' '),
      },
      request.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    );
  }

  /**
   * RFC 8693 exchange. Delegation always narrows: audience is rebound to
   * the target, scopes are the intersection of what the subject token
   * holds and what was requested, and the acting party is appended to the
   * nested act chain. The original principal stays in sub.
   */
  async exchange(request: ExchangeRequest): Promise<IssuedToken> {
    const subject = await this.verifyOwnToken(request.subjectToken);
    const held = scopesOf(subject);
    const scopes = request.scopes === undefined ? held : intersectScopes(request.scopes, held);

    const actor = request.actor ?? request.client.principal;
    if (actor !== request.client.principal && !request.client.roles.includes('platform')) {
      throw new AuthError(
        `client ${request.client.client_id} may not exchange on behalf of actor ${actor}: platform role required`,
        403,
      );
    }
    // Idempotent actor: re-exchanging under the same acting party (e.g. an
    // agent narrowing its own token toward a tool audience) must not
    // duplicate links in the delegation chain.
    const act: ActClaim =
      subject.act?.sub === actor
        ? subject.act
        : { sub: actor, ...(subject.act !== undefined ? { act: subject.act } : {}) };

    return this.sign(
      {
        sub: subject.sub,
        aud: request.audience,
        tenant: subject.tenant,
        roles: subject.roles,
        scope: scopes.join(' '),
        act,
      },
      request.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    );
  }

  /** Subject tokens must be our own, currently valid platform JWTs (any audience — exchange rebinds it). */
  private async verifyOwnToken(token: string): Promise<PlatformClaims> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(this.keys.jwks), {
        issuer: this.issuer,
      });
      return assertPlatformClaims(payload);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(
        `subject_token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function clampTtl(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(requested), MAX_TTL_SECONDS);
}
