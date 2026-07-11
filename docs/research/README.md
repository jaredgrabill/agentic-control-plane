# Research Briefs

Point-in-time research (compiled **2026-07-10**) that grounds the platform
architecture. Each brief states which claims were verified against primary
sources and which come from secondary sources or model training data.

These are inputs, not normative documents — the architecture docs and ADRs are
the source of truth for decisions. When a brief and an ADR disagree, the ADR
wins.

| Brief | Feeds into |
|---|---|
| [Protocols & Interoperability](protocols-and-interop.md) — MCP, A2A, registries, composition patterns | [ADR-0006](../adr/0006-mcp-tools-a2a-agent-cards.md), [messaging-and-discovery](../architecture/messaging-and-discovery.md), [agent-lifecycle](../architecture/agent-lifecycle.md) |
| [Governance, Safety & Security](governance-safety-security.md) — OWASP ASI, NIST AI RMF, EU AI Act, identity, policy engines, audit | [security](../architecture/security.md), [governance-and-policy](../architecture/governance-and-policy.md), [ADR-0004](../adr/0004-stateless-jwt-rbac.md) |
| [Observability, Evaluation & Cost](observability-eval-cost.md) — OTel GenAI conventions, eval gates, FinOps for AI | [observability](../architecture/observability.md), [evaluation](../architecture/evaluation.md), [cost-management](../architecture/cost-management.md) |
| [Infrastructure Stack](infra-stack.md) — NATS, Temporal, pgvector, OSS project standards | [ADR-0001](../adr/0001-nats-messaging-and-discovery.md), [ADR-0002](../adr/0002-temporal-workflow-orchestration.md), [ADR-0003](../adr/0003-pgvector-for-rag.md), [coding-standards](../standards/coding-standards.md) |
