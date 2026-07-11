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
/** ADR-0007: broker grounds older than this are refused (defense-in-depth against snapshot replay). */
export const DEFAULT_MAX_TASK_AGE_SECONDS = 86_400;

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

/**
 * ADR-0007 broker grant: a broker-role client asserts a subject claim set
 * (the orchestrator's intake snapshot) instead of presenting a live subject
 * token. Grounds tie the mint back to the intake verification for audit.
 */
export interface DelegateRequest {
  client: RegisteredClient;
  /** Asserted principal snapshot, verified by the broker at task intake. */
  subject: { sub: string; tenant: string; roles: string[]; scopes: string[] };
  audience: string;
  /** Result scopes = intersectScopes(requested, subject.scopes) — never widens. */
  scopes?: string[] | undefined;
  /** Acting party for the new token, e.g. agent:cloud-agent@0.1.0. */
  actor?: string | undefined;
  grounds: { task_id: string; subject_jti?: string | undefined; verified_at: string };
  ttlSeconds?: number | undefined;
}

export interface IssuedToken {
  token: string;
  expiresIn: number;
  claims: PlatformClaims;
}

export class TokenIssuer {
  private readonly maxTaskAgeSeconds: number;

  constructor(
    private readonly keys: KeyStore,
    private readonly issuer: string,
    options?: { maxTaskAgeSeconds?: number },
  ) {
    this.maxTaskAgeSeconds = options?.maxTaskAgeSeconds ?? DEFAULT_MAX_TASK_AGE_SECONDS;
  }

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

  /**
   * ADR-0007 broker delegation. No live subject token changes hands: the
   * broker asserts the claim set it verified at intake, and the service
   * enforces the invariants the exchange path enforces — scopes intersect
   * (never widen), the act chain records the true actors, and the minted
   * token is clamped to ≤ 15 minutes like every other token.
   */
  async delegate(request: DelegateRequest): Promise<IssuedToken> {
    if (!request.client.roles.includes('broker')) {
      throw new AuthError(
        `client ${request.client.client_id} may not broker delegations: broker role required (ADR-0007)`,
        403,
      );
    }
    const { subject } = request;
    if (
      typeof subject.sub !== 'string' ||
      subject.sub === '' ||
      typeof subject.tenant !== 'string' ||
      subject.tenant === '' ||
      !Array.isArray(subject.roles) ||
      subject.roles.some((r) => typeof r !== 'string') ||
      !Array.isArray(subject.scopes) ||
      subject.scopes.some((s) => typeof s !== 'string')
    ) {
      throw new AuthError(
        'subject must assert sub, tenant, roles[] and scopes[] — the snapshot the broker verified at intake',
        400,
      );
    }
    this.assertFreshGrounds(request.grounds);

    const scopes =
      request.scopes === undefined
        ? subject.scopes
        : intersectScopes(request.scopes, subject.scopes);

    // Same two-hop chain the exchange path produced: user → broker when the
    // broker takes custody, user → actor → broker when it delegates onward —
    // delegationChain() keeps yielding user → svc:orchestrator → agent.
    const actor = request.actor ?? request.client.principal;
    const act: ActClaim =
      actor === request.client.principal
        ? { sub: request.client.principal }
        : { sub: actor, act: { sub: request.client.principal } };

    return this.sign(
      {
        sub: subject.sub,
        aud: request.audience,
        tenant: subject.tenant,
        roles: subject.roles,
        scope: scopes.join(' '),
        act,
        brokered: {
          task_id: request.grounds.task_id,
          ...(request.grounds.subject_jti === undefined
            ? {}
            : { subject_jti: request.grounds.subject_jti }),
          verified_at: request.grounds.verified_at,
        },
      },
      request.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    );
  }

  /** Grounds must reference a recent intake verification: stale, unparseable, or future timestamps are refused. */
  private assertFreshGrounds(grounds: DelegateRequest['grounds']): void {
    const verifiedAt = Date.parse(grounds.verified_at);
    if (Number.isNaN(verifiedAt)) {
      throw new AuthError(
        `broker grounds are stale: verified_at ${JSON.stringify(grounds.verified_at)} is not a parseable timestamp`,
        403,
      );
    }
    const ageSeconds = (Date.now() - verifiedAt) / 1000;
    if (ageSeconds < 0) {
      throw new AuthError(
        `broker grounds are stale: verified_at ${grounds.verified_at} is in the future`,
        403,
      );
    }
    if (ageSeconds > this.maxTaskAgeSeconds) {
      throw new AuthError(
        `broker grounds are stale: verified_at ${grounds.verified_at} is older than ` +
          `${this.maxTaskAgeSeconds}s (ACP_BROKER_MAX_TASK_AGE_SECONDS) — the task outlived the broker window`,
        403,
      );
    }
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
