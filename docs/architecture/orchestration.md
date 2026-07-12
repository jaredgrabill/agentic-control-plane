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
| `ApprovalWorkflow` (child) | Human gate for R2 capabilities: notify approvers, `wait_condition` on signal (hours/days at zero compute), escalate on timeout, deny by default. **v1 (item 1):** launched by `AgentStepWorkflow` when `authorizeDelegation` returns three-way require-approval; waits on `approvalDecisionSignal` up to `deny_after_s = 86400s`, escalates (notification only) at `escalate_after_s = 3600s`, first-valid-decision-wins with self-approval/digest-mismatch signals rejected-and-counted; timeout DENIES. On grant, `AgentStepWorkflow` re-discovers the agent and brokers the step token with a signed `approval` claim bound to the step (`StepDispatch` carries the full plan + digest for the approver's blast-radius view). A denied/timed-out gate fails the step `policy_denied` "not executed" → dependents gap → honest partial; ZERO `TaskWorkflow` loop changes. |
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
| Kill switch mid-task (v1) | Dispatch-time discovery of a suspended agent fails the next step → the unwind trigger fires and the compensation stack unwinds. A `POST /v1/tasks/:id/cancel` (or fleet cancel) drains the in-flight wave, unwinds, and returns status `cancelled`. Fleet-wide auto-cancellation via NATS is item 5. |
| Worker crash | Temporal replays; activities are idempotent by standard (idempotency keys on all writes) |

Partial results are a first-class outcome: a cross-domain brief with four of
five agents reporting is delivered as such, with the gap stated — never
silently backfilled by the LLM.

## Compensation (saga stacks) — v1

The orchestrator keeps a **compensation stack**: after every wave it pushes, in
wave order (deterministic under replay), one entry per step that **completed**
and whose executed capability is an **R2/R3 write with a declared compensator**.
Only the child `AgentStepWorkflow` knows the discovered capability (dispatch-time
discovery), so it returns the write's risk, compensator, and approval grounds to
the parent as executed metadata.

**All-or-nothing for change plans.** A plan that contains R2 writes is a change
plan; half a change is worse than none. The stack unwinds when it is non-empty
AND a trigger fired — `step_failure` (any failed/skipped step, including
dependency skips), `budget_exhausted`, or `cancellation`. If every step
completed and nothing was cancelled, the writes are kept (no compensation
events). Accepted v1 cost: an unrelated R0 branch failure tears down a good
write in the same plan — governed plans are cohesive, and the report states what
was undone and why. Dependency-scoped compensation is documented future work.

**Unwind is LIFO, sequential, and re-gated at nothing.** Each compensator is
dispatched through the SAME governed pipeline (discovery → policy → broker →
audits) with a `compensation` flag, in reverse of the push order. The
compensator's input is derived **mechanically** from the recorded write —
`{original: {step_id, capability, input, output}}` — never attacker-supplied.
The unwind runs with **no budget gate** (cleanup is a safety obligation, and
budget exhaustion may be the very trigger; usage is still tallied). Compensator
executions reuse `step.dispatched`/`step.completed` with `details.compensation`,
bracketed by `compensation.started` (entries in unwind order) and
`compensation.completed` (status/trigger/compensated/failed/irreversible).

**Failed writes are never compensated (v1).** A write that *failed* left the
side-effect state unknown; re-running its compensator could corrupt or double
an effect. Only completed writes are on the stack. **Irreversible** completed
writes (declared `irreversible: true`, no compensator) are never dispatched —
they are listed in the compensation block and a gap states the write "was not
undone".

**Compensator failure is first-class.** A compensator that fails (or whose agent
cannot be discovered) emits `compensation.step_failed`, is recorded under
`failed`, and the unwind **continues** for the remaining entries (they are
independent; aborting would strand them). The task reports
`compensation.status: incomplete` with a gap naming the write that "remains in
effect". It never changes the task status by itself.

**Cancellation drains, then unwinds, and reports `cancelled`.** The TaskWorkflow
body runs inside `CancellationScope.nonCancellable`; a cancel (operator abort or
kill switch) sets a flag and cancels only the current wave's explicit scope.
Pre-dispatch phases (discovery, policy, **approval wait**, broker) abort
promptly — the child catches the cancellation and reports the step as *not
executed* (nothing to compensate). The dangerous `execute_capability` phase and
its `step.completed` audit are **shielded** in a non-cancellable scope, so a
mid-write cancel lets the write finish and be recorded — the platform then KNOWS
the write happened and unwinds it, rather than leaving unknown state. The task
then marks unstarted steps skipped, unwinds, and returns a `TaskResult` with
status **`cancelled`** — deliberately NOT a `CancelledFailure`, so
`handle.result()` still retrieves the honest report (gaps + compensation block).

**Compensators are pre-authorized; unwind never re-gates.** See
governance-and-policy.md: the original write's approval authorizes its
compensator, so a `require-approval` verdict on a compensation dispatch is a
policy bug that fails closed as compensation-incomplete — the compensation
branch has no `ApprovalWorkflow`. The `compensation` flag can only originate in
the TaskWorkflow unwind loop (agents never construct a `StepDispatch`), and is
carried defense-in-depth by a signed, broker-minted `compensation` token claim.
