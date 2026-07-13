# ADR-0006: MCP for Tool Access; A2A-Compatible Agent Cards for Discovery

- **Status:** Accepted
- **Date:** 2026-07-10 (accepted 2026-07-13, Phase 4 item 3)
- **Deciders:** platform architecture group

## Context

Two protocol layers need standardizing: agent↔tool (how agents call
enterprise systems) and agent↔agent (how capabilities are described,
discovered, and composed). The 2026 landscape has consolidated: **MCP** is
the de facto tool protocol (2026-07-28 revision brings a stateless core;
OAuth 2.1 authorization; an official registry format), and **A2A v1.0**
(Linux Foundation) owns the agent-boundary layer with signed Agent Cards —
the two are explicitly complementary ("MCP vertical, A2A horizontal").
ACP merged into A2A in 2025. Agent frameworks (LangGraph, CrewAI, OpenAI
Agents SDK, MS Agent Framework) remain fragmented — which is an argument for
standardizing at protocol boundaries, not framework choice
([research](../research/protocols-and-interop.md)).

## Decision

- **All tool access is MCP** (Streamable HTTP, stateless-core style),
  fronted by the tool gateway. No bespoke tool RPC.
- **Capability manifests are a superset of A2A Agent Cards**: every
  registered agent's card is exportable as a spec-compliant, JWS-signed A2A
  card; skills/schemas/security-scheme fields map directly.
- **Internal transport ≠ external protocol:** inside the platform,
  delegation runs over NATS/Temporal for efficiency and governance; at the
  edge, the Gateway can expose selected agents as A2A endpoints and onboard
  external A2A agents as proxied registry records ([messaging-and-discovery.md](../architecture/messaging-and-discovery.md)).
- **Agent frameworks are swappable internals.** The platform contract is
  manifest + handler signature; what runs inside a handler (LangGraph, plain
  loops, anything) is the team's business.

## Alternatives Considered

- **A2A as the internal transport too:** HTTP point-to-point between agents
  defeats the no-direct-paths invariant and duplicates what NATS/Temporal
  already provide (durability, queues, isolation); we adopt A2A's *data
  model* (cards, task states) without its wire topology internally.
- **Proprietary tool protocol:** better fit to our gateway features in the
  short run; ecosystem suicide in an open-source project — every enterprise
  already building MCP servers couldn't reuse them.
- **AGNTCY/OASF for capability schemas:** richer taxonomy, far thinner
  adoption; we track it as a design reference and can add an OASF export
  later without changing internals.
- **Standardizing on one agent framework** (LangGraph et al.): couples the
  platform to a fast-moving dependency and forces every team's internals;
  protocol boundaries are the stable layer.

## Consequences

- Every existing MCP server is a candidate platform tool with a wrapper
  review; our tool servers are usable outside the platform.
- Interop with the broader agent ecosystem (Copilot Studio, Bedrock
  AgentCore, etc.) comes through A2A at the edge, without compromising
  internal governance.
- We accept tracking two evolving specs (MCP revisions; A2A minor versions)
  — pinned versions per release, upgrades via ADR-noted platform releases.
- Revisit if: A2A discovery/registry standardization matures to where our
  registry should *be* an A2A registry rather than export to one.

## Implementation (Phase 4 item 3)

- **Signed A2A card EXPORT only.** The registry translates a card through a
  strict opt-in allowlist projection (`apps/registry/src/a2a.ts`) — never
  exporting `tools`, scopes, `models`, `data_classification`, saga wiring,
  `eval_baseline`, `tenant`, or `sla` — and re-signs it as a detached JWS with
  the registry key (the sole signer). The gateway serves it unauthenticated at
  `/.well-known/agent.json` (index) and `/v1/a2a/agents/:id/.well-known/agent.json`;
  a non-exposed or unknown agent answers an identical 404. Exposure is a
  platform allowlist (`deploy/dev/a2a-exposure.json`), never agent-authored.
  The card `url` is documented-inert: the inbound A2A EXECUTION endpoint is out
  of scope and stays closed until separately designed.
- **External agents onboard as proxy registry records.** `@acp/a2a-proxy` is a
  thin adapter that IS an `@acp/agent-sdk` `Agent`, so the orchestrator PEP
  gates it byte-for-byte like a native agent. It authenticates to the remote
  with its OWN `ACP_PROXY_CREDENTIAL`; the broker `delegated_token` never
  egresses. Remote replies are untrusted (output schema-validated by the SDK,
  first-party lineage stripped, remote citations dropped, remote usage not
  booked). A2A `input-required` maps to a `needs_input` step outcome, never an
  approval grant. See [messaging-and-discovery.md](../architecture/messaging-and-discovery.md).
- **server.json tool-server catalog** lives in the registry, opt-in behind
  `ACP_TOOL_CATALOG_URL` (default OFF, static-file fallback). Secrets are never
  stored — `auth.credential_ref` is an env/vault key name expanded at the tool
  gateway. See [tool-integration.md](../standards/tool-integration.md).
