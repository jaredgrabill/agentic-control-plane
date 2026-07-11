# ADR-0004: Stateless JWT Auth with RBAC and Token-Exchange Delegation

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** platform architecture group

## Context

Every actor — humans, services, each agent version, each tool server — needs
authenticated identity on every hop, with delegation chains (user →
orchestrator → agent → tool) preserved for least-privilege and audit. The
platform is horizontally scaled and multi-service; per-request session
lookups would couple every service to a session store. 2026 practice for
agent identity converges on: non-human identities per agent, short-lived
audience-bound tokens, RFC 8693 token exchange with `act` claims, optional
SPIFFE workload attestation ([research](../research/governance-safety-security.md)).

## Decision

We will use **stateless, short-lived JWTs with RBAC**, and **RFC 8693 token
exchange for every delegation**:

- Asymmetric signing, JWKS rotation; local verification in every service.
- TTL ≤ 15 minutes; audience-bound per target service.
- Coarse roles (archetypes) + fine scopes (per capability, per tool);
  delegation always issues the **intersection** of delegator permissions and
  target manifest — never the union.
- Delegation chain carried in nested `act` claims (aligned with the IETF
  on-behalf-of-for-agents direction).
- One deliberate statefulness exception: a **revocation denylist**
  (kill-switched agents/principals) distributed via NATS KV, checked at the
  Gateway and tool gateway.
- SPIFFE/SPIRE + mTLS as the hardened deployment profile (workload
  attestation underneath the JWT layer, not instead of it).
- OIDC federation at the edge: enterprise IdPs authenticate humans; the
  Token Service issues platform JWTs from IdP assertions.

## Alternatives Considered

- **Opaque tokens + introspection:** central session store on every hop —
  a bottleneck and single point of failure the stateless design exists to
  avoid; instant revocation is its one advantage, which the denylist
  recovers at far lower cost.
- **mTLS-only (SPIFFE as the whole story):** strong workload identity but no
  natural carrier for user delegation context, scopes, or `act` chains;
  we use it *under* JWTs, not instead.
- **ABAC-first policy in tokens:** attribute explosion in tokens; we keep
  tokens lean (identity + roles + scopes) and put attribute logic in Cedar
  where it's testable and versioned ([governance-and-policy.md](../architecture/governance-and-policy.md)).

## Consequences

- Verification scales horizontally with zero shared state; a captured
  credential is worth ≤ 15 minutes of narrowly-scoped access.
- We accept eventual revocation (TTL window) for everything below
  kill-switch severity; the denylist handles the severe cases within
  seconds.
- Token Service becomes critical infrastructure (issuance + exchange on the
  hot path) — stateless by design, horizontally scaled, aggressively cached
  JWKS.
- Revisit if: the IETF agent-delegation drafts standardize materially
  different claims (we'd migrate claim shapes, not architecture).
