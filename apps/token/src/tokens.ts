import { randomUUID } from 'node:crypto';
import {
  AuthError,
  assertPlatformClaims,
  intersectScopes,
  scopesOf,
  type ActClaim,
  type ApprovalClaim,
  type CapabilityClaim,
  type CompensationClaim,
  type DeploymentClaim,
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

/**
 * The read side of the kill switch the issuer needs (ADR-0007 broker-time
 * denylist, item 0c). Structurally satisfied by service-kit's
 * KillSwitchWatcher; injectable so unit tests stub it. All three return a
 * truthy state only when the switch is ACTIVE.
 */
export interface KillSwitchLike {
  fleetHalt(): unknown;
  /** Per-tenant halt (Phase 4 item 1) — a fleet halt scoped to one tenant. */
  tenantHalt(tenant: string): unknown;
  agentSuspension(agentId: string): unknown;
  principalDenied(sub: string): unknown;
  /** Tier-2 named-capability flag (item 5) — blocks even a compensator. */
  capabilitySuspension(name: string): unknown;
  /** Tier-2 monotonic risk-class flag (item 5) — exempt for a compensator. */
  riskClassSuspension(risk: string): unknown;
}

/** Why a mint was refused, for the token.denied audit and the 403 body. */
export interface TokenDenial {
  reason:
    | 'fleet_halt'
    | 'killswitch'
    | 'principal_denylist'
    | 'capability_killswitch'
    | 'risk_killswitch';
  /** The kill-switch tier that tripped (audit details). */
  tier: 'fleet' | 'agent' | 'principal' | 'capability' | 'risk';
  /** The tier target (agent id, capability name, risk class, principal, or 'fleet'). */
  target: string;
  /** The control-KV key that tripped, e.g. killswitch.agent.cloud-agent. */
  key: string;
  /** The offending principal (suspended agent, denylisted subject). */
  principal: string;
  tenant: string;
}

/**
 * A mint refused at broker time because an identity is revoked — distinct
 * from a scope/shape AuthError. 403, and carries the denial so the app can
 * emit a token.denied audit event.
 */
export class TokenDeniedError extends AuthError {
  constructor(
    readonly denial: TokenDenial,
    message: string,
  ) {
    super(message, 403);
    this.name = 'TokenDeniedError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const RISK_CLASSES = new Set(['R0', 'R1', 'R2', 'R3']);

/**
 * Human-approval grounds a broker asserts when minting a step token AFTER an
 * ApprovalWorkflow granted the gated delegation. Shape-validated at mint;
 * the resulting signed claim is what the tool gateway binds to the step.
 */
export interface ApprovalGrounds {
  approval_id: string;
  decision_id: string;
  approver: string;
  step_id: string;
  capability: string;
  subject_digest: string;
}

/**
 * Compensation grounds a broker asserts when minting a compensator step token
 * during a saga unwind (Phase 3 item 2). Shape-validated at mint; the signed
 * `compensation` claim is what item 3's tool-gateway PEP reads as
 * `context.compensation` so a compensator's R2 tool call is not re-gated.
 * Mutually exclusive with approval grounds: a single mint is either the
 * gated write (approval) or its compensator (compensation), never both.
 */
export interface CompensationGrounds {
  original_step_id: string;
  original_capability: string;
  approval_id?: string;
  approver?: string;
}

/**
 * Capability grounds a broker asserts when minting ANY step token (Phase 3
 * item 3): the exact capability executing and its declared risk class. Unlike
 * approval/compensation grounds, these ride EVERY brokered step token (R0..R2),
 * because the tool-gateway risk-class PEP needs the executing risk on every
 * call — laundering an R2 tool through an R0/R1 step must be visible. Shape-
 * validated at the mint; the signed `capability` claim is what item 3's tool
 * gateway reads as `context.capability` and enforces `rank(tool) <= rank(cap)`.
 */
export interface CapabilityGrounds {
  name: string;
  risk: string;
}

/**
 * Deployment grounds a broker asserts when minting a SHADOW step token (Phase 3
 * item 4): the deployment mode. Set ONLY by the orchestrator's
 * ShadowStepWorkflow. Shape-validated at the mint; the signed `deployment`
 * claim is what the tool gateway reads to suppress side effects for a shadow
 * step (R0 reads execute; R1+ writes are refused and recorded). v0 accepts
 * `mode: 'shadow'` only.
 */
export interface DeploymentGrounds {
  mode: string;
}

const DEPLOYMENT_MODES = new Set(['shadow']);

/** `agent:{id}@{version}` (or `agent:{id}`) → the bare kill-switch id; undefined for non-agents. */
function agentIdOf(principal: string): string | undefined {
  if (!principal.startsWith('agent:')) return undefined;
  return principal.slice('agent:'.length).split('@')[0];
}

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
  /**
   * Required — the broker must say exactly what it wants (the target's
   * manifest tool bindings). Result scopes = intersectScopes(requested,
   * subject.scopes) — never widens, and an empty request grants nothing.
   */
  scopes: string[];
  /** Acting party for the new token, e.g. agent:cloud-agent@0.1.0. */
  actor?: string | undefined;
  grounds: { task_id: string; subject_jti?: string | undefined; verified_at: string };
  /**
   * Human-approval grounds — present only when the orchestrator brokers a
   * step token after an ApprovalWorkflow granted the R2 delegation. Signed
   * into the token as the `approval` claim; the tool gateway binds it to the
   * exact step before permitting the write.
   */
  approval?: ApprovalGrounds | undefined;
  /**
   * Compensation grounds — present only when the orchestrator brokers a
   * compensator step token during a saga unwind. Signed into the token as the
   * `compensation` claim; item 3's tool gateway reads it as
   * `context.compensation`. Mutually exclusive with `approval` (400 if both).
   */
  compensation?: CompensationGrounds | undefined;
  /**
   * Capability grounds — the executing capability's name and declared risk
   * class. Present on every brokered step token so the tool gateway can
   * enforce risk classes on every tool call. Signed into the token as the
   * `capability` claim. Optional: an absent claim is treated as R0 context
   * downstream (fail-safe — only R0 tools pass).
   */
  capability?: CapabilityGrounds | undefined;
  /**
   * Deployment grounds — present only when the orchestrator's
   * ShadowStepWorkflow brokers a shadow step token. Signed into the token as
   * the `deployment` claim; the tool gateway reads it to suppress side effects.
   */
  deployment?: DeploymentGrounds | undefined;
  ttlSeconds?: number | undefined;
}

export interface IssuedToken {
  token: string;
  expiresIn: number;
  claims: PlatformClaims;
}

export class TokenIssuer {
  private readonly maxTaskAgeSeconds: number;
  private readonly killSwitch: KillSwitchLike | undefined;

  constructor(
    private readonly keys: KeyStore,
    private readonly issuer: string,
    options?: { maxTaskAgeSeconds?: number; killSwitch?: KillSwitchLike },
  ) {
    this.maxTaskAgeSeconds = options?.maxTaskAgeSeconds ?? DEFAULT_MAX_TASK_AGE_SECONDS;
    this.killSwitch = options?.killSwitch;
  }

  /**
   * ADR-0007 broker-time denylist. Returns the first denial that applies —
   * fleet halt, then agent suspension, then principal denylist — so a
   * revoked identity gets NO fresh token (its outstanding ones live out
   * their ≤15min; the tool-gateway/callout checks block use in seconds).
   */
  private denialFor(params: {
    tenant: string;
    primaryPrincipal: string;
    checkFleet: boolean;
    agentPrincipals: string[];
    denylistPrincipals: string[];
    /**
     * The executing capability grounds (item 5). When present, the mint is
     * refused if the named capability is suspended (blocks even a compensator)
     * or — for a NON-compensator mint — a covering risk-class flag is active.
     */
    capability?: CapabilityGrounds;
    /** True when this mint carries compensation grounds — fleet + risk exempt. */
    isCompensation?: boolean;
  }): TokenDenial | undefined {
    const ks = this.killSwitch;
    if (ks === undefined) return undefined;
    if (params.checkFleet && ks.fleetHalt() !== undefined) {
      return {
        reason: 'fleet_halt',
        tier: 'fleet',
        target: 'fleet',
        key: 'killswitch.fleet',
        principal: params.primaryPrincipal,
        tenant: params.tenant,
      };
    }
    for (const p of params.agentPrincipals) {
      const id = agentIdOf(p);
      if (id !== undefined && ks.agentSuspension(id) !== undefined) {
        return {
          reason: 'killswitch',
          tier: 'agent',
          target: id,
          key: `killswitch.agent.${id}`,
          principal: p,
          tenant: params.tenant,
        };
      }
    }
    for (const p of params.denylistPrincipals) {
      if (ks.principalDenied(p) !== undefined) {
        return {
          reason: 'principal_denylist',
          tier: 'principal',
          target: p,
          key: `killswitch.principal.${p}`,
          principal: p,
          tenant: params.tenant,
        };
      }
    }
    // Tier-2 capability/risk flags (item 5). A named-capability flag blocks even
    // a compensator (surgical intent wins); a covering risk-class flag is EXEMPT
    // for a compensator so an unwind can still mint its token under a class halt.
    if (params.capability !== undefined) {
      if (ks.capabilitySuspension(params.capability.name) !== undefined) {
        return {
          reason: 'capability_killswitch',
          tier: 'capability',
          target: params.capability.name,
          key: `killswitch.capability.${params.capability.name}`,
          principal: params.primaryPrincipal,
          tenant: params.tenant,
        };
      }
      if (
        params.isCompensation !== true &&
        ks.riskClassSuspension(params.capability.risk) !== undefined
      ) {
        return {
          reason: 'risk_killswitch',
          tier: 'risk',
          target: params.capability.risk,
          key: `killswitch.risk.${params.capability.risk}`,
          principal: params.primaryPrincipal,
          tenant: params.tenant,
        };
      }
    }
    return undefined;
  }

  private assertNotDenied(grant: string, params: Parameters<TokenIssuer['denialFor']>[0]): void {
    const denial = this.denialFor(params);
    if (denial !== undefined) {
      throw new TokenDeniedError(
        denial,
        `${grant} refused: ${denial.reason} on ${denial.principal} (${denial.key}) — ` +
          'a revoked identity gets no fresh token (ADR-0007 broker-time denylist)',
      );
    }
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
    // Broker-time denylist. The principal denylist applies to EVERY
    // principal — a denylisted user or service must not client_credentials-mint
    // a fresh token any more than a denylisted agent may (0c QA MEDIUM:
    // previously the whole check was gated on `startsWith('agent:')`, so a
    // denylisted user/service kept minting). Fleet halt and agent suspension
    // stay agent-only: halting the fleet must not stop the control plane
    // issuing its own service tokens.
    const isAgent = request.client.principal.startsWith('agent:');
    this.assertNotDenied('issue', {
      tenant: request.client.tenant,
      primaryPrincipal: request.client.principal,
      checkFleet: isAgent,
      agentPrincipals: isAgent ? [request.client.principal] : [],
      denylistPrincipals: [request.client.principal],
    });
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
    // Broker-time denylist: a killed agent cannot convert tokens it still
    // holds — the effective actor must not be suspended or denylisted.
    this.assertNotDenied('exchange', {
      tenant: subject.tenant,
      primaryPrincipal: actor,
      checkFleet: false,
      agentPrincipals: [actor],
      denylistPrincipals: [actor],
    });
    // Idempotent actor: re-exchanging under the same acting party (e.g. an
    // agent narrowing its own token toward a tool audience) must not
    // duplicate links in the delegation chain. And when the requested actor
    // IS the subject with no chain at all (the tool gateway re-scoping a
    // plain user token toward acp:knowledge), no delegation happened — the
    // exchange must not fabricate an act link, or downstream PEPs would
    // record a bogus [user, user] chain.
    const sameActor = subject.act?.sub === actor;
    const act: ActClaim | undefined = sameActor
      ? subject.act
      : actor === subject.sub && subject.act === undefined
        ? undefined
        : { sub: actor, ...(subject.act !== undefined ? { act: subject.act } : {}) };

    // Governance-claim exchange propagation (SPRINT cross-item contract,
    // item-3 D2): broker-minted grounds ride VERBATIM only across same-actor
    // narrowing exchanges — the existing idempotent-actor branch. This is
    // what lets an agent's per-call acp:agent→acp:tools exchange (post-0c
    // audience flip) still carry the brokered.task_id binding downstream
    // PEPs check. Any actor-appending exchange or chain-free rescope DROPS
    // it (a new actor must not inherit another actor's task grounds). The
    // claim can only come from the verified subject token — the exchange
    // endpoint accepts no body-supplied brokered claim — so there is no
    // injection path. Item 3 formalizes the full claim list; 0c ships
    // `brokered`, the one claim already minted (supersedes design-0c §4's
    // "no brokered claim propagates").
    const brokered = sameActor ? subject.brokered : undefined;
    // Item 1: the human-approval claim rides the SAME same-actor branch as
    // `brokered`. After the 0c audience flip an agent presents an exchanged
    // acp:tools token, so the tool gateway reads `approval` from the exchanged
    // token — which only works because it propagates here. A new actor
    // (actor-appending exchange) or a chain-free rescope inherits neither
    // claim. No injection path: the claim can only come from the verified
    // subject token; the exchange endpoint accepts no body-supplied approval.
    const approval = sameActor ? subject.approval : undefined;
    // Item 2: the compensation claim rides the SAME same-actor branch as
    // `brokered` and `approval`. A compensator agent presents an exchanged
    // acp:tools token; item 3's tool gateway reads `compensation` from that
    // exchanged token, which only works because it propagates here. A new
    // actor (actor-appending exchange) or a chain-free rescope inherits none
    // of the three claims. No injection path: the claim can only come from the
    // verified subject token; the exchange endpoint accepts no body-supplied
    // compensation.
    const compensation = sameActor ? subject.compensation : undefined;
    // Item 3: the capability claim rides the SAME same-actor branch as
    // `brokered`, `approval`, and `compensation`. This is the load-bearing
    // propagation for the tool-gateway risk-class check: an agent presents an
    // exchanged acp:tools token, so the gateway reads `capability` (the
    // executing risk class) from the EXCHANGED token — which only works
    // because it propagates here. A new actor (actor-appending exchange) or a
    // chain-free rescope inherits NONE of the four claims: a stolen R2-context
    // token cannot be laundered onto a different actor to launder its risk.
    // No injection path: the claim can only come from the verified subject
    // token; the exchange endpoint accepts no body-supplied capability.
    const capability = sameActor ? subject.capability : undefined;
    // Item 4: the deployment claim rides the SAME same-actor branch as the four
    // before it (brokered, approval, compensation, capability). This is the
    // load-bearing propagation for shadow suppression: the ShadowStepWorkflow's
    // shadow agent presents an exchanged acp:tools token, so the tool gateway
    // reads `deployment.mode === 'shadow'` from the EXCHANGED token — which only
    // works because it propagates here. A new actor (actor-appending exchange)
    // or a chain-free rescope inherits NONE of the five claims: a stolen shadow
    // token cannot be laundered onto a different actor. No injection path: the
    // claim can only come from the verified subject token; the exchange endpoint
    // accepts no body-supplied deployment.
    const deployment = sameActor ? subject.deployment : undefined;

    return this.sign(
      {
        sub: subject.sub,
        aud: request.audience,
        tenant: subject.tenant,
        roles: subject.roles,
        scope: scopes.join(' '),
        ...(act !== undefined ? { act } : {}),
        ...(brokered !== undefined ? { brokered } : {}),
        ...(approval !== undefined ? { approval } : {}),
        ...(compensation !== undefined ? { compensation } : {}),
        ...(capability !== undefined ? { capability } : {}),
        ...(deployment !== undefined ? { deployment } : {}),
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
    // A single mint is either the gated write (approval) or its compensator
    // (compensation) — never both. Refuse the contradiction before signing.
    if (request.approval !== undefined && request.compensation !== undefined) {
      throw new AuthError(
        'a mint may carry approval grounds OR compensation grounds, not both — the gated write ' +
          'and its compensator are distinct dispatches',
        400,
      );
    }
    const approvalClaim =
      request.approval === undefined
        ? undefined
        : buildApprovalClaim(request.approval, subject.sub);
    const compensationClaim =
      request.compensation === undefined ? undefined : buildCompensationClaim(request.compensation);
    const capabilityClaim =
      request.capability === undefined ? undefined : buildCapabilityClaim(request.capability);
    const deploymentClaim =
      request.deployment === undefined ? undefined : buildDeploymentClaim(request.deployment);

    // Explicit-or-nothing: no "default to the snapshot" branch. A toolless
    // agent (requested = []) mints a token with zero scopes, keeping the
    // ADR-0007 narrowing chain intact: brokered ⊆ requested ⊆ snapshot.
    const scopes = intersectScopes(request.scopes, subject.scopes);

    // Same two-hop chain the exchange path produced: user → broker when the
    // broker takes custody, user → actor → broker when it delegates onward —
    // delegationChain() keeps yielding user → svc:orchestrator → agent.
    const actor = request.actor ?? request.client.principal;
    // Broker-time denylist: refuse to mint a fresh step token for a halted
    // fleet, a suspended target agent, or a denylisted subject/actor — this
    // is what stops a suspended agent getting new tokens for a task's life.
    // Item 5 extends this to tier-2 capability/risk flags read from the
    // executing capability grounds, with the compensation-exemption matrix: a
    // fleet halt and a covering risk-class flag are EXEMPT for a compensator
    // mint (else a halt makes an in-flight write permanently un-compensable),
    // but a named-capability flag blocks even a compensator.
    const isCompensationMint = request.compensation !== undefined;
    this.assertNotDenied('delegate', {
      tenant: subject.tenant,
      primaryPrincipal: actor,
      checkFleet: !isCompensationMint,
      agentPrincipals: [actor],
      denylistPrincipals: [subject.sub, actor],
      ...(request.capability === undefined ? {} : { capability: request.capability }),
      isCompensation: isCompensationMint,
    });
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
        ...(approvalClaim !== undefined ? { approval: approvalClaim } : {}),
        ...(compensationClaim !== undefined ? { compensation: compensationClaim } : {}),
        ...(capabilityClaim !== undefined ? { capability: capabilityClaim } : {}),
        ...(deploymentClaim !== undefined ? { deployment: deploymentClaim } : {}),
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

/**
 * Validates approval grounds and shapes the signed `approval` claim. Every
 * field is checked at the mint so a malformed or self-approved grant never
 * becomes a signed claim: ids are uuids, the digest is a sha256 digest, and
 * the approver is a non-empty principal that is NOT the subject — structural
 * separation of duties enforced independently of the gateway's own check.
 */
function buildApprovalClaim(raw: unknown, subjectSub: string): ApprovalClaim {
  const bad = (msg: string): never => {
    throw new AuthError(`approval grounds rejected: ${msg}`, 400);
  };
  if (typeof raw !== 'object' || raw === null) bad('must be an object');
  const grounds = raw as ApprovalGrounds;
  if (typeof grounds.approval_id !== 'string' || !UUID_RE.test(grounds.approval_id)) {
    bad('approval_id must be a uuid');
  }
  if (!UUID_RE.test(grounds.decision_id)) bad('decision_id must be a uuid');
  if (!UUID_RE.test(grounds.step_id)) bad('step_id must be a uuid');
  if (typeof grounds.capability !== 'string' || grounds.capability === '') {
    bad('capability must be a non-empty string');
  }
  if (!DIGEST_RE.test(grounds.subject_digest)) bad('subject_digest must be a sha256:<hex> digest');
  if (typeof grounds.approver !== 'string' || grounds.approver === '') {
    bad('approver must be a non-empty principal');
  }
  if (grounds.approver === subjectSub) {
    bad(
      `approver ${grounds.approver} is the subject of the request — an approver may not ` +
        'approve their own delegation (separation of duties)',
    );
  }
  return {
    id: grounds.approval_id,
    decision_id: grounds.decision_id,
    approver: grounds.approver,
    step_id: grounds.step_id,
    capability: grounds.capability,
    subject_digest: grounds.subject_digest,
  };
}

/**
 * Validates compensation grounds and shapes the signed `compensation` claim.
 * Every field is checked at the mint: the original step is a uuid, the
 * original capability matches the capability pattern, and the optional
 * approval_id/approver (present when the original write was gated) are a uuid
 * and a non-empty principal. A malformed field never becomes a signed claim.
 */
function buildCompensationClaim(raw: unknown): CompensationClaim {
  const bad = (msg: string): never => {
    throw new AuthError(`compensation grounds rejected: ${msg}`, 400);
  };
  if (typeof raw !== 'object' || raw === null) bad('must be an object');
  const grounds = raw as CompensationGrounds;
  if (typeof grounds.original_step_id !== 'string' || !UUID_RE.test(grounds.original_step_id)) {
    bad('original_step_id must be a uuid');
  }
  if (
    typeof grounds.original_capability !== 'string' ||
    !CAPABILITY_RE.test(grounds.original_capability)
  ) {
    bad('original_capability must be a capability name (e.g. change.submit)');
  }
  if (grounds.approval_id !== undefined && !UUID_RE.test(grounds.approval_id)) {
    bad('approval_id, when present, must be a uuid');
  }
  if (
    grounds.approver !== undefined &&
    (typeof grounds.approver !== 'string' || grounds.approver === '')
  ) {
    bad('approver, when present, must be a non-empty principal');
  }
  return {
    original_step_id: grounds.original_step_id,
    original_capability: grounds.original_capability,
    ...(grounds.approval_id === undefined ? {} : { approval_id: grounds.approval_id }),
    ...(grounds.approver === undefined ? {} : { approver: grounds.approver }),
  };
}

/**
 * Validates capability grounds and shapes the signed `capability` claim. The
 * name must match the capability pattern and the risk must be one of the four
 * declared classes — a malformed capability or an unknown risk never becomes a
 * signed claim, because the tool gateway enforces risk from exactly this field.
 */
function buildCapabilityClaim(raw: unknown): CapabilityClaim {
  const bad = (msg: string): never => {
    throw new AuthError(`capability grounds rejected: ${msg}`, 400);
  };
  if (typeof raw !== 'object' || raw === null) bad('must be an object');
  const grounds = raw as CapabilityGrounds;
  if (typeof grounds.name !== 'string' || !CAPABILITY_RE.test(grounds.name)) {
    bad('name must be a capability name (e.g. change.submit)');
  }
  if (typeof grounds.risk !== 'string' || !RISK_CLASSES.has(grounds.risk)) {
    bad('risk must be one of R0, R1, R2, R3');
  }
  return { name: grounds.name, risk: grounds.risk };
}

/**
 * Validates deployment grounds and shapes the signed `deployment` claim. The
 * mode must be a known deployment mode — v0 accepts `shadow` only. A malformed
 * or unknown mode never becomes a signed claim, because the tool gateway
 * suppresses side effects from exactly this field.
 */
function buildDeploymentClaim(raw: unknown): DeploymentClaim {
  const bad = (msg: string): never => {
    throw new AuthError(`deployment grounds rejected: ${msg}`, 400);
  };
  if (typeof raw !== 'object' || raw === null) bad('must be an object');
  const grounds = raw as DeploymentGrounds;
  if (typeof grounds.mode !== 'string' || !DEPLOYMENT_MODES.has(grounds.mode)) {
    bad("mode must be 'shadow' (the only v0 deployment mode)");
  }
  return { mode: grounds.mode };
}
