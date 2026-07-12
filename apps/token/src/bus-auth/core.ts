/**
 * BusAuthCore: the pure decision function for the NATS auth callout (item
 * 0c). Given the platform JWT an agent presented at connect time, it decides
 * whether to mint a session-scoped bus identity and, if so, produces the
 * user JWT — with ZERO network calls (local KeyStore verification). The thin
 * NATS wiring (xkey decrypt, response signing, audit) lives in responder.ts,
 * so a hardened profile can split the decision from the transport.
 *
 * Fail closed by construction: any verification/policy failure — including a
 * credential-less connect — returns an error, and the server then refuses
 * the connection. A valid platform token for the wrong audience, role, or a
 * kill-switched identity is refused.
 */

import { AuthError, assertPlatformClaims, type PlatformClaims } from '@acp/service-kit';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { KeyStore } from '../keys.js';
import type { KillSwitchLike } from '../tokens.js';
import { encodeUserJwt, type NatsPermissions, type Signer } from './nats-jwt.js';

/** The one audience an agent's bus token must carry — cross-audience replay is dead. */
export const BUS_AUDIENCE = 'acp:bus';

const AGENT_SUB = /^agent:([a-z0-9-]+)@/;

export interface BusAuthConfig {
  /** Issuer account public key (A…) signing minted user JWTs. */
  issuerPublic: string;
  /** ed25519 signer — the issuer account nkey's sign. */
  sign: Signer;
  /** tenant claim → NATS account NAME, e.g. { acme: "TENANT_ACME" }. */
  tenantAccounts: Record<string, string>;
  /**
   * Extra publishable platform-service subjects (the retriever RPC surface).
   * Default is the knowledge search subject; do NOT widen without review.
   */
  agentSvcSubjects: string[];
  killSwitch?: KillSwitchLike | undefined;
}

export type BusAuthDecision =
  | {
      ok: true;
      userJwt: string;
      account: string;
      principal: string;
      tenant: string;
      agentId: string;
    }
  | { ok: false; error: string; principal?: string | undefined; tenant?: string | undefined };

export class BusAuthCore {
  constructor(
    private readonly keys: KeyStore,
    private readonly issuer: string,
    private readonly config: BusAuthConfig,
  ) {}

  async evaluate(req: {
    authToken: string | undefined;
    userNkey: string;
  }): Promise<BusAuthDecision> {
    if (req.authToken === undefined || req.authToken === '') {
      return { ok: false, error: 'no bus token presented — the callout fails closed' };
    }

    // 1) Verify the platform JWT locally: signature, issuer, and the exact
    //    acp:bus audience. A token for any other audience throws here.
    let claims: PlatformClaims;
    let expUnix: number;
    try {
      const { payload } = await jwtVerify(req.authToken, createLocalJWKSet(this.keys.jwks), {
        issuer: this.issuer,
        audience: BUS_AUDIENCE,
      });
      // jose's audience check passes for an ARRAY aud that merely CONTAINS
      // acp:bus. Mirror the tool gateway's single-string strictness: a bus
      // token must be good for exactly acp:bus and nothing else — a
      // multi-audience token would silently widen where it can be replayed.
      if (typeof payload.aud !== 'string') {
        throw new AuthError(
          'bus token aud must be a single string, not an array (multi-audience refused)',
        );
      }
      claims = assertPlatformClaims(payload);
      if (typeof payload.exp !== 'number') {
        return { ok: false, error: 'bus token has no exp — refusing an unbounded session' };
      }
      expUnix = payload.exp;
    } catch (err) {
      const message =
        err instanceof AuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: `bus token rejected: ${message}` };
    }

    // 2) Role gate: only agent-role principals get a tenant bus identity.
    if (!claims.roles.includes('agent')) {
      return {
        ok: false,
        error: `bus token for ${claims.sub} is not an agent-role token`,
        principal: claims.sub,
        tenant: claims.tenant,
      };
    }

    // 3) Subject shape: must be agent:{id}@{version}.
    const match = AGENT_SUB.exec(claims.sub);
    const agentId = match?.[1];
    if (agentId === undefined) {
      return {
        ok: false,
        error: `bus token sub ${claims.sub} is not a versioned agent principal (agent:{id}@{version})`,
        principal: claims.sub,
        tenant: claims.tenant,
      };
    }

    // 4) Tenant must map to a known account.
    const account = this.config.tenantAccounts[claims.tenant];
    if (account === undefined) {
      return {
        ok: false,
        error: `no bus account for tenant ${claims.tenant}`,
        principal: claims.sub,
        tenant: claims.tenant,
      };
    }

    // 5) Kill switch: halted fleet, suspended agent, or denylisted principal
    //    is refused at connection time (identity revocation at the door).
    const ks = this.config.killSwitch;
    if (ks !== undefined) {
      const reason =
        ks.fleetHalt() !== undefined
          ? 'fleet halt'
          : ks.agentSuspension(agentId) !== undefined
            ? `agent ${agentId} suspended`
            : ks.principalDenied(claims.sub) !== undefined
              ? `principal ${claims.sub} denylisted`
              : undefined;
      if (reason !== undefined) {
        return {
          ok: false,
          error: `bus session refused: ${reason}`,
          principal: claims.sub,
          tenant: claims.tenant,
        };
      }
    }

    // 6) Mint: exp = platform exp (the bus identity dies with its token);
    //    permissions from today's static template, parameterized by tenant
    //    and agent id — no permission reaches another agent or a
    //    platform-internal subject.
    const userJwt = encodeUserJwt({
      issuerPublic: this.config.issuerPublic,
      userNkey: req.userNkey,
      account,
      name: claims.sub,
      expUnix,
      permissions: this.permissionsFor(claims.tenant, agentId),
      sign: this.config.sign,
    });

    return { ok: true, userJwt, account, principal: claims.sub, tenant: claims.tenant, agentId };
  }

  private permissionsFor(tenant: string, agentId: string): NatsPermissions {
    return {
      pub: {
        allow: [
          `acp.${tenant}.audit.>`,
          `acp.${tenant}.telemetry.>`,
          ...this.config.agentSvcSubjects,
          '_INBOX.>',
        ],
      },
      sub: {
        allow: [
          `acp.${tenant}.agent.${agentId}.>`,
          'acp.platform.registry.>',
          'acp.platform.control.>',
          '_INBOX.>',
        ],
      },
    };
  }
}
