# SLO Targets (1.0)

> **Status: PROPOSED — pending human ratification.** These are the concrete
> 1.0 targets distilled from the SLI/SLO draft in
> [observability.md](../architecture/observability.md). The *dimensions* and
> *measurement approach* are settled; the *numeric thresholds* below are
> proposals a maintainer ratifies before they gate a release. Until ratified,
> treat them as alerting guidance, not release gates.

Every target below is measured from the platform's OpenTelemetry signals
(`gen_ai.*` GenAI semantic conventions plus the `acp.*` governance namespace)
and the online-evaluation state machine (budget / ladder). One task is one
trace; SLIs are computed over traces and the metrics the SDK emits at span
close, never from bespoke per-agent instrumentation.

## Service-level objectives

| # | Dimension | SLI (definition) | Proposed target | Window | Metric / source | Burn / alert condition |
|---|---|---|---|---|---|---|
| 1 | **Availability** | Fraction of dispatched steps that reach a terminal `completed`/`failed` result without an infrastructure error (bus/gateway/orchestrator fault, not an agent's honest failure) | ≥ **99.5%** dispatch success | 30-day rolling | `acp.step.dispatch.count` split by `outcome`; cross-checked against `step.dispatched` vs `step.completed` audit events | Multi-window burn-rate: page at 14.4× budget burn over 1h **and** 5m; ticket at 6× over 6h |
| 2a | **Latency — task** | End-to-end wall time from `task.submitted` to `task.completed` for the reference agents | p95 < **30 s** | 1h / 24h rolling | task-duration histogram (`acp.task.duration`, derived from the task trace root span) | p95 > target sustained 15m → warn; > 2× target 5m → page |
| 2b | **Latency — LLM step** | `gen_ai.client.operation.duration` per model call | p95 within the agent's declared `sla.p95_latency_s` | 1h rolling | `gen_ai.client.operation.duration` histogram, grouped by `acp.agent_version` | p95 > agent SLA sustained 15m → warn |
| 2c | **Latency — TTFT** | Time to first token on streamed model calls | **tracked** (no hard gate at 1.0) | 1h rolling | `gen_ai.server.time_to_first_token` (where the provider exposes it) | Informational; trend only |
| 3 | **Queue depth / backlog** | Depth of the per-agent task queues; should drain to ~0 between bursts | Backlog ≈ 0 steady-state; **no sustained growth** | 5m rolling | `acp.queue.depth` gauge per `acp.agent_id` (Temporal task-queue backlog) | Alert when `backlog > N · throughput` sustained > 5m (default N = 2 — the queue is not draining faster than it fills) |
| 4a | **Retrieval — hit rate** | Fraction of retrieval-backed answers whose citations resolve to a served chunk (grounded answers) | ≥ **baseline** for the agent | 24h rolling | `acp.retrieval.hit` counter + citation-resolution check | Drop > tolerance below the recorded eval baseline → warn |
| 4b | **Retrieval — citation precision** | Precision of citations vs the judge/eval standard | ≥ recorded eval baseline (see [evaluation.md](../architecture/evaluation.md)) | 24h rolling | online judge score (`eval.score`) sampled per trace | Joint-condition drift alert (input drift **and** score drop) |
| 5a | **Budget burn** | `burn_ratio` = spend / budget for the current period (per tenant / agent) | < **0.5** warning · < **1.0** exhausted | period (see cost-management) | online-eval budget engine (`online-eval/budget.ts`); `eval.budget_state_changed` | `burn_ratio ≥ 0.5` → warning; `≥ 1.0` → **exhausted → change-freeze** |
| 5b | **Quality state** | Ladder `quality_state` per agent | steady state = **measurable** | continuous | online-eval ladder (`online-eval/ladder.ts`); `quality_state` table | `warning` → owner alert; `exhausted`/`severe`/`floor` → routing demotion / suspend (see [threat model drift loop](../architecture/threat-model.md)) |
| 6 | **Audit lag** | Delay from an action occurring to its record being durably appended and hash-chained; the stream is append-only with no gaps | p95 < **a few seconds** (proposed 5 s) | 1h rolling | append timestamp vs `occurred_at` on `acp.*.audit.*`; chain continuity from the audit verify walk | p95 > target sustained 15m → warn; **any** chain gap / verify failure → page (integrity, not latency) |

## How these map to alerting

- **Budget & quality** SLOs (#5) are enforced *in code today* by the
  online-evaluation engine — the burn-rate and ladder thresholds above are
  the same constants the engine already acts on (`burn_ratio` 0.5 / 1.0;
  ladder `measurable → warning → exhausted → severe → floor`). The Prometheus
  rules in `deploy/observability/prometheus/rules.yml` mirror them for
  dashboards and paging; they do not replace the engine's own enforcement.
- **Availability, latency, backlog, audit-lag** (#1, #2, #3, #6) are the
  operability SLOs that the Prometheus rules alert on directly.
- **Retrieval** (#4) is gated primarily by the offline/online eval baselines
  (evaluation.md); the dashboard surfaces it, the eval gate enforces it.

## Recoverability (first-class, per observability.md)

| Signal | Target |
|---|---|
| Kill-switch propagation (kill decision → agent suspended) | < **10 s** (SLO from observability.md / threat model) |
| Mean time to detect a bad output | tracked; bounded by probe cadence |
| Rollback time (bad deploy → previous baseline restored) | tracked |

## Ratification checklist (human-gated)

Before any of these gate a release, a maintainer must:

1. Confirm the numeric targets against real traffic once the reference agents
   run under sustained load (use the harness in `tests/load/`).
2. Fix `N` for the backlog alert (#3) per observed burst shape.
3. Confirm the audit-lag p95 target against the real append path.
4. Record the ratified values here and drop the **PROPOSED** banner.

The dashboards (`deploy/observability/dashboards/`) and alert rules render
these SLOs today so ratification is a review of live evidence, not a
guess.
