# ADR-0001: NATS for Messaging and Dynamic Discovery

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** platform architecture group

## Context

The platform needs: low-latency RPC between control-plane services and
agents; dynamic discovery of agents that come and go without redeploys;
durable, replayable event streams for audit and telemetry; watchable
distributed state (kill switch, flags, registry cache); and hard multi-tenant
isolation on all of it. Candidates evaluated: NATS (+JetStream), Kafka (+
separate RPC layer + registry), RabbitMQ, Redis Streams, gRPC + Consul.

A licensing concern hung over NATS in 2024–25; the Synadia/CNCF dispute was
settled May 2025 with the server remaining Apache 2.0 under CNCF stewardship
([research](../research/infra-stack.md)).

## Decision

We will use **NATS as the single messaging substrate**:

- **Core request-reply** for RPC and control commands (at-most-once;
  durability belongs to Temporal, not the bus).
- **Services framework (`micro`)** for service discovery, health, and stats —
  no external registry component.
- **JetStream** for the audit stream, telemetry events, and task events.
- **JetStream KV** for registry cache, feature/policy flags, kill-switch
  state.
- **Accounts** as the tenant isolation boundary; **auth callout** to bridge
  platform JWTs to per-session, subject-scoped bus permissions.

## Alternatives Considered

- **Kafka + gRPC + Consul:** Kafka wins on massive-throughput streaming we
  don't need, and costs three systems (streaming, RPC, discovery) plus much
  heavier ops. Discovery and request-reply are afterthoughts in that stack;
  they are native in NATS.
- **RabbitMQ:** solid queueing, but no comparable multi-tenancy model,
  discovery story, or KV; streams are newer and less proven than JetStream.
- **Redis (Streams + pub/sub):** attractive operationally, but weak
  durability guarantees historically, no account-style isolation, and
  licensing churn of its own.
- **gRPC mesh only:** point-to-point defeats the "no direct agent-to-agent
  paths" invariant; every governance boundary would need bespoke middleware.

## Consequences

- One substrate to operate, secure, and reason about; subject-based
  permissions give us the "agents physically cannot message each other"
  invariant for free.
- We accept NATS's smaller ecosystem vs Kafka and design around JetStream
  limits (no blob payloads; KV lacks read-your-writes on followers —
  authoritative reads go to Postgres).
- Auth-callout service becomes availability-critical (connection-time
  dependency) — it must be stateless and horizontally scaled.
- Revisit if: sustained event throughput approaches JetStream cluster
  limits, or a future licensing change alters the Apache 2.0 status.
