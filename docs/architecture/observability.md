# Observability

Observability is SDK-supplied, not agent-supplied: an agent built from the
template emits correct telemetry with zero effort, and *cannot easily not*.
Research basis: [observability-eval-cost brief](../research/observability-eval-cost.md).

## Telemetry Standard: OpenTelemetry + `gen_ai.*`

- **Traces, metrics, and logs are OTel end to end**, using the GenAI
  semantic conventions (`gen_ai.*` namespace): `invoke_agent` spans with
  child `chat` (LLM) and `execute_tool` spans — the standard trace shape for
  agent runs.
- The conventions are still pre-stable, so the SDK **pins a semconv version**
  and owns the mapping; agents never hand-write attribute names. Convention
  upgrades are one SDK release, not a fleet migration.
- Platform-specific attributes ride a parallel namespace (`acp.tenant`,
  `acp.task_id`, `acp.agent_version`, `acp.capability`, `acp.risk_class`,
  `acp.policy_decision`) — attribution and governance context on every span.
- **Prompt/completion content capture is opt-in and off by default**
  (metadata always; bodies only where tenant policy allows), matching the
  OTel privacy posture. Content capture routes through the same PII
  redaction as the gateway.
- Export via standard OTLP to a collector; backends are pluggable (the
  platform is backend-agnostic — Langfuse/Phoenix/vendor APMs all ingest
  OTLP). The dev stack ships a batteries-included collector + UI.

## The Trace Is the Product

One task = one trace, end to end: gateway → workflow → every agent step →
every LLM and tool call → policy decisions → synthesis. Session/conversation
grouping links multi-turn tasks. This single artifact serves:

- **Engineers:** debugging ("why did the NetSec step time out?")
- **Reviewers/auditors:** the audit record links to the trace; replay uses it
- **Evaluation:** online judges score sampled traces; golden sets are built
  from them
- **Cost:** the Cost Meter prices spans at close from `gen_ai.usage.*`

Temporal's own history gives execution-level observability (retries, queue
latency, gate waits); trace IDs are propagated into workflow/activity
headers so the two views cross-link.

**Context propagation is SDK plumbing:** W3C `traceparent`/`tracestate`
ride NATS message headers and Temporal workflow/activity headers, injected
and extracted by both SDKs automatically — one trace ID survives every
Python↔TypeScript hop, bus dispatch, and durable wait without any agent
code touching it.

## Metrics and SLOs

Standard dashboards per agent (auto-provisioned at registration):

| Dimension | SLIs | Example SLO |
|---|---|---|
| Availability | dispatch success, heartbeat | 99.5% dispatch success |
| Latency | `gen_ai.client.operation.duration` p50/p95, end-to-end task time, time-to-first-token | p95 step < agent SLA |
| Quality | online judge score, task success rate, citation precision, escalation rate, human-override rate | judge score ≥ 0.90 (see [evaluation.md](evaluation.md)) |
| Cost | tokens and $ per task, per capability | cost/task within ±20% of baseline |
| Safety | guardrail trigger rate, policy denial rate, injection detections | any spike alerts |

**Error budgets extend to quality:** burning the quality budget freezes
prompt/model changes for that agent exactly as an availability budget
freezes deploys. Budget state is visible in the registry record.

**Behavioral regression alerting** fires on the *joint* condition — input
drift **and** eval-score drop — rather than either alone (noise control),
plus tool-error spikes and feedback downturns.

**Recoverability metrics** are tracked as first-class: mean time to detect a
bad output, time to suspend an agent (SLO < 10 s from kill decision),
rollback time.

## Logging

Structured JSON only (SDK logger), trace-correlated (`trace_id` on every
line), with the same redaction pipeline as content capture. Log levels are
runtime-adjustable per agent via the control KV — debugging in production
without redeploying.

## Feedback Capture

Thumbs/scores/annotations from end users and approvers attach to the trace
(OTel events), flow to the Evaluation Service, and seed golden datasets.
The feedback loop is platform plumbing, not per-agent bespoke work.
