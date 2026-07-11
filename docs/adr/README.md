# Architecture Decision Records

We record every significant architecture decision as an ADR: short, numbered,
immutable once accepted. Changing a decision means a new ADR that supersedes
the old one — the history of *why* stays intact.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-nats-messaging-and-discovery.md) | NATS for messaging and dynamic discovery | Proposed |
| [0002](0002-temporal-workflow-orchestration.md) | Temporal for durable workflow orchestration | Proposed |
| [0003](0003-pgvector-for-rag.md) | Postgres + pgvector for retrieval | Proposed |
| [0004](0004-stateless-jwt-rbac.md) | Stateless JWT auth with RBAC and delegation | Proposed |
| [0005](0005-language-split-typescript-python.md) | TypeScript control plane, polyglot agent SDKs | Proposed |
| [0006](0006-mcp-tools-a2a-agent-cards.md) | MCP for tools; A2A-compatible agent cards for discovery | Proposed |

## Statuses

`Proposed` → `Accepted` → (`Superseded by ADR-XXXX` | `Deprecated`)

## Template

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Deciders:** names/roles

## Context

What forces are at play? What problem are we solving? Neutral tone — a reader
should not be able to guess the decision from the context alone.

## Decision

What we chose, stated actively: "We will ...".

## Alternatives Considered

Each rejected option with the honest reason it lost.

## Consequences

What becomes easier, what becomes harder, what risks we accept, and what
would trigger revisiting this decision.
```
