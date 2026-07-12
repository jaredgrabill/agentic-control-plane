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

**Status: 🚧 walking skeleton (roadmap Phase 1).** The design docs below are
implemented as a running system: token service, gateway, registry, Cedar
policy engine, Temporal orchestrator, audit trail, knowledge service, the
Python agent SDK, and the first agent — one R0 agent answering one question
end-to-end with every governance boundary real. Feedback via issues and
discussions is very welcome.

## Quickstart (the Phase 1 exit scenario)

```bash
make dev        # substrate: NATS, Temporal, Postgres+pgvector, OTel, Jaeger
pnpm install && pnpm build
cd python && uv sync && cd ..
make e2e        # register agent → ingest corpus → cited answer → audit → kill switch
```

Or run it interactively: `make platform`, then submit
*"What does our policy say about change freezes?"* through the gateway with
a real JWT (see `tests/e2e/src/exit-scenario.test.ts` for the exact calls)
and watch the trace land in Jaeger (http://localhost:16686) and the
delegation chain in the audit API.

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
