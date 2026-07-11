# ADR-0005: TypeScript Control Plane, Polyglot Agent SDKs

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** platform architecture group

## Context

The platform commits to Python and TypeScript. The question is where each
lives. Forces: the LLM/agent ecosystem and most agent authors lean Python;
control-plane services are API- and concurrency-heavy where TypeScript's
tooling and Temporal's TS SDK (deterministic V8 isolate workflows) are
strong; Temporal is polyglot across task queues, so workflow language and
activity language are independent; two SDKs must not drift apart.

## Decision

- **Control plane (all services in `apps/`) and Temporal workflows:
  TypeScript.** One language for the platform brain: gateway, registry,
  policy, orchestrator, deployment, evaluation, audit.
- **Agents: Python or TypeScript**, as first-class equals. Two SDKs
  (`acp-agent-sdk` on PyPI, `@acp/agent-sdk` on npm) with matching
  scaffolders (`uvx acp-create-agent`, `pnpm create @acp/agent`) and a
  parity requirement per release.
- **Contracts generated, never hand-written twice:** `packages/protocol`
  holds JSON Schema/OpenAPI sources; TypeScript types and Pydantic models
  are both generated from it.
- Reference agents ship in both languages (Knowledge/NetSec in Python;
  Cloud/Source-Code in TypeScript) so both paved roads are continuously
  proven.

## Alternatives Considered

- **Python everywhere:** simplest staffing story, but Temporal workflow
  determinism is easier to enforce in the TS isolate model, and
  control-plane services (gateway, registry) are squarely in TS's
  strengths; it would also make the TS agent SDK a second-class afterthought.
- **TypeScript everywhere:** alienates the majority of the LLM ecosystem
  (evals tooling, ML libraries, agent frameworks are Python-first); agent
  teams would fight the platform.
- **Go/Rust control plane:** performance headroom we don't need at the cost
  of a third language, violating the two-language commitment.

## Consequences

- Orchestration expertise concentrates in one codebase; agent teams never
  write workflow code (the intended division of labor).
- We accept the cost of SDK parity: every SDK-surface change is specified
  in the protocol package first and implemented twice. CI enforces
  cross-language contract tests on shared fixtures.
- Hiring/contribution surface is broad (the two most common languages),
  matching an MIT open-source posture.
- Revisit if: SDK parity cost dominates platform velocity (then: consider
  generating more of the SDK itself from specs).
