# ADR-0002: Temporal for Durable Workflow Orchestration

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** platform architecture group

## Context

Agent tasks are long-running (minutes to days with human approvals),
multi-step, cross fragile external systems, and must be exactly-as-intended:
retried on transient failure, compensated on abort, resumable across
crashes, and fully auditable. Hand-rolling this on queues + state machines
is the classic distributed-systems tar pit. Candidates: Temporal, AWS Step
Functions, Airflow/Dagster, LangGraph-style checkpointing, bespoke NATS
consumers.

Temporal has first-class AI-agent patterns (agent loop as workflow, HITL via
signals, OpenAI Agents SDK integration GA 2026), GA worker versioning, and
mature Python and TypeScript SDKs ([research](../research/infra-stack.md)).

## Decision

We will use **Temporal (self-hosted) for all multi-step task execution**:

- **Workflows in TypeScript** — orchestration is control-plane code, one
  language, deterministic by sandbox.
- **Activities polyglot** — agents implement activities on Python or
  TypeScript workers via language/team-specific task queues.
- Human approval gates as signal-awaited workflows; compensation stacks for
  R2 writes; one task queue per rate-limited downstream; worker versioning
  (GA) for code evolution; continue-as-new for long agent loops.

## Alternatives Considered

- **AWS Step Functions:** managed and durable, but cloud-locked (the
  platform is open source and must run anywhere), JSON-state programming
  model fights complex agent logic, and local dev/testing is weak.
- **Airflow/Dagster:** batch DAG engines; wrong shape for reactive,
  signal-driven, long-waiting tasks with human gates.
- **LangGraph checkpointing:** in-process durability for one agent's graph,
  not cross-service orchestration with queues, rate limits, and polyglot
  workers; also couples orchestration to one agent framework, which
  [ADR-0006](0006-mcp-tools-a2a-agent-cards.md) forbids.
- **Bespoke NATS JetStream consumers + state tables:** maximum control,
  but we would spend the novelty budget rebuilding Temporal poorly.

## Consequences

- Reliability semantics (retry, timeout, compensation, replay) become
  declarative and testable; the workflow history doubles as an execution
  audit trail cross-linked to OTel traces.
- We accept operating a Temporal cluster (or Temporal Cloud where adopters
  choose it) and its learning curve — determinism rules, history limits
  (50k events → continue-as-new discipline), payload limits (references,
  not blobs).
- TypeScript-only workflows concentrate orchestration expertise; agent
  teams never write workflow code, which is exactly the intended division.
- Revisit if: Temporal licensing/stewardship changes, or task volume makes
  per-step history cost dominate (then: coarser activities, same
  architecture).
