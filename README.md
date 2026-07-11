# Agentic Control Plane

**An open-source control plane for composable, governed AI agents.**

Specialized agents — knowledge & policy, change/ITSM, network security,
cloud, source code — discover each other, delegate work, and produce
auditable, policy-compliant answers to questions that today take an engineer
six tools and an afternoon:

> *"Can we roll out this firewall change tonight?"* → one question in, and
> back comes a cited risk brief: network exposure (NetSec agent), affected
> infrastructure (Cloud agent), dependent services (Source Code agent),
> change-freeze policy (Knowledge agent), and a drafted change record (ITSM
> agent) — with the full trail of every agent consulted, every tool called,
> and every policy check applied.

**Status: 🚧 design phase.** This repository currently contains the platform
architecture, engineering standards, and roadmap — under review before
implementation begins. Feedback via issues and discussions is very welcome.

## Why This Exists

Single-purpose AI assistants can't answer cross-domain questions, and
ungoverned agent frameworks can't be trusted with enterprise systems. The
gap is a **control plane**: shared services and protocols that make agents
composable *and* governed — where governance is enforced by the platform's
boundaries, so no agent can opt out.

- **Governance is the product** — policy decisions on every tool call,
  append-only decision provenance, tiered kill switches, risk-classed
  capabilities with human approval gates.
- **Agents earn trust continuously** — eval-gated deployment
  (shadow → canary → ramp), calibrated LLM judges, drift detection, quality
  error budgets. An agent that regresses gets demoted automatically.
- **Dynamic by design** — agents register, version, canary, and retire
  without platform redeploys; discovery is a governed registry query.
- **Paved road** — scaffold to shadow-mode production in days:
  telemetry, evals, budgets, and policy come free with the SDK
  (Python and TypeScript, first-class equals).

## Architecture at a Glance

| Layer | Technology | Role |
|---|---|---|
| Control plane | TypeScript services | gateway, registry, policy (Cedar), orchestration, deployment, evaluation, cost, audit |
| Orchestration | [Temporal](https://temporal.io) (TS workflows, polyglot workers) | durable task execution, approval gates, compensation |
| Messaging & discovery | [NATS](https://nats.io) (core + JetStream) | RPC, dynamic discovery, audit/event streams, multi-tenant isolation |
| Knowledge / RAG | Postgres + [pgvector](https://github.com/pgvector/pgvector) | hybrid retrieval with citations and classification-aware access |
| Identity | Stateless JWT + RBAC, RFC 8693 token exchange | delegation chains, least privilege on every hop |
| Protocols | [MCP](https://modelcontextprotocol.io) (tools) + [A2A](https://a2a-protocol.org)-compatible agent cards (discovery) | open standards at every boundary |
| Observability | OpenTelemetry `gen_ai.*` conventions | one trace per task, cost-attributed at span close |

Start with the **[Architecture Overview](docs/architecture/overview.md)**.

## Documentation Map

- **Vision & scope** — [docs/vision.md](docs/vision.md) · [docs/domains.md](docs/domains.md)
- **Architecture** — [overview](docs/architecture/overview.md) ·
  [agent lifecycle](docs/architecture/agent-lifecycle.md) ·
  [messaging & discovery](docs/architecture/messaging-and-discovery.md) ·
  [orchestration](docs/architecture/orchestration.md) ·
  [knowledge & RAG](docs/architecture/knowledge-and-rag.md) ·
  [security](docs/architecture/security.md) ·
  [threat model](docs/architecture/threat-model.md) ·
  [governance & policy](docs/architecture/governance-and-policy.md) ·
  [observability](docs/architecture/observability.md) ·
  [evaluation](docs/architecture/evaluation.md) ·
  [cost management](docs/architecture/cost-management.md)
- **Standards** — [agent patterns](docs/standards/agent-patterns.md) ·
  [tool integration](docs/standards/tool-integration.md) ·
  [coding standards](docs/standards/coding-standards.md) ·
  [testing](docs/standards/testing.md) ·
  [review practices](docs/standards/review-practices.md) ·
  [the paved road](docs/standards/paved-road.md)
- **Decisions** — [ADR index](docs/adr/README.md)
- **Research** — [research briefs](docs/research/README.md) (July 2026 state of the art)
- **Plan** — [ROADMAP.md](ROADMAP.md)

## Contributing

Design-phase contributions (architecture review, ADR discussion, roadmap
feedback) are open now — see [CONTRIBUTING.md](CONTRIBUTING.md). Project
governance is described in [GOVERNANCE.md](GOVERNANCE.md); security reports
go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
