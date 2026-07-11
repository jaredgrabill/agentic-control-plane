# Orchestration (Temporal)

Every multi-step task runs as a **Temporal workflow**. This is the platform's
central reliability decision: LLMs decide *what* to do; Temporal guarantees
*that it happens* — retries, timeouts, human gates, compensation — durably
and deterministically. Decision record: [ADR-0002](../adr/0002-temporal-workflow-orchestration.md).

## Language Split

- **Workflows: TypeScript.** All orchestration logic lives in the control
  plane's TypeScript codebase (deterministic V8 isolate sandbox catches
  nondeterminism at build time). One language for the platform brain.
- **Activities: polyglot.** Agents implement activities in Python or
  TypeScript on their own **task queues** — Temporal is language-agnostic
  across workers, so a TS workflow drives Python agents natively. This is
  what lets agent teams choose their ecosystem (Python for LLM tooling, TS
  for API-heavy domains) without fragmenting orchestration.

## Workflow Taxonomy

| Workflow | Purpose |
|---|---|
| `TaskWorkflow` | Top-level per user task: plan → delegate → synthesize → respond. Holds conversation state; receives user messages as Updates. |
| `AgentStepWorkflow` (child) | One delegated step to one agent: token exchange, dispatch, guardrail check on output, retry policy. |
| `ApprovalWorkflow` (child) | Human gate for R2 capabilities: notify approvers, `wait_condition` on signal (hours/days at zero compute), escalate on timeout, deny by default. |
| `IngestionWorkflow` | Knowledge pipeline: fetch → chunk (assign `lineage_id`) → ledger write → embed (rate-limited activities) → index. Retries guarantee ledger and index converge; `lineage_id` is the idempotency key. |
| `DeploymentWorkflow` | Shadow/canary progression: mirror, soak, evaluate gates, ramp or rollback. |
| `EvalRunWorkflow` | Golden-set and probe execution with budget-capped fan-out. |

## Core Patterns

**Plan-then-execute.** For open-ended tasks the workflow first materializes a
plan (an LLM activity returning a typed plan artifact), then executes plan
steps as child workflows. The plan is recorded before execution — auditors
and approvers see intent, not just outcomes, and prompt-injected mid-course
"plan changes" require an explicit replan step that re-runs policy checks.
Known task shapes (the acceptance scenarios in [domains.md](../domains.md))
skip LLM planning entirely: they are code-defined workflows with LLM decision
points only inside bounded nodes.

> **Status:** v1 implemented with a deterministic rule planner
> (`rule-planner@1`): typed `Plan` artifact recorded as `task.planned`,
> dependency-wave fan-out with per-step dispatch-time discovery and brokered
> tokens (ADR-0007), budget ledger (`max_steps`/`max_tokens` gate dispatch),
> honest partial results with gaps. Flat plans only — no nesting, no
> mid-course replanning. The LLM planner swaps in behind the same schema
> validation once the LLM gateway lands.

**Agent loop as workflow.** An agent turn = LLM activity + tool activities in
a loop, with the workflow owning the loop counter, token budget, and
step cap. Completed activity results persist in workflow history, so a
worker or node crash resumes the task at its exact step **without re-buying
completed LLM calls** — durability is a cost control, not just a
reliability one. Runaway loops die by construction: budgets are workflow state, not
agent self-discipline. Long conversations `continue-as-new` before the 50k
event-history cap, carrying summarized state; transcripts live in Postgres,
referenced by ID (payloads stay under Temporal's blob limits).

**Message passing.** Queries for reads (task status), Signals for
fire-and-forget (cancellation, kill switch), **Updates** for
request-response with the running task ("user replied; return the agent's
next message"). Handlers only enqueue; the main loop drains — the
entity-workflow discipline.

**Saga/compensation.** Every R2 write capability must declare a compensating
action in its manifest (e.g., `change.submit` ⇄ `change.withdraw`). The
workflow keeps a compensation stack; on failure or cancellation it unwinds in
reverse order — if the NetSec agent opened a temporary security-group rule
and the subsequent deployment step fails, the rule is torn down
automatically before the task reports failure. R2 capabilities without a declared compensator are rejected at
registration unless explicitly flagged `irreversible` — which raises their
approval requirements.

**Rate limiting.** One task queue per rate-limited downstream: each LLM
provider and each fragile enterprise API (ITSM, firewall manager) gets its
own queue with server-enforced `max_task_queue_activities_per_second`.
Backpressure becomes queue depth, visible and alertable, instead of 429
storms.

## Versioning Workflows

- **Worker Versioning (GA)** as the default: workflow executions pin to the
  worker deployment version that started them; new versions deploy as new
  workers. Long-lived entity workflows adopt new code at the
  continue-as-new boundary (upgrade-on-CaN).
- `workflow.patched()` reserved for emergency in-place fixes; patches carry a
  removal ticket from birth.
- Workflow *code* versioning is independent of *agent* versioning — the
  registry pins which agent version a workflow step targets, so a canary
  agent and an incumbent agent can serve under the same workflow code.

## Failure Semantics

| Failure | Handling |
|---|---|
| LLM call fails / rate-limited | Activity retry with backoff (Temporal-native); provider failover via LLM gateway after N attempts |
| Agent returns schema-invalid output | One structured-repair retry, then step failure — never "best-effort parse" |
| Agent step exceeds SLA | Activity timeout → retry on healthy worker → step failure → plan-level fallback (degrade, or report partial results honestly) |
| Approval times out | Deny by default; task reports the unapproved step as not executed |
| Kill switch mid-task | Cancellation signal → compensation stack unwinds → task reports partial state |
| Worker crash | Temporal replays; activities are idempotent by standard (idempotency keys on all writes) |

Partial results are a first-class outcome: a cross-domain brief with four of
five agents reporting is delivered as such, with the gap stated — never
silently backfilled by the LLM.
