# Change / ITSM Agent

Governed change management over the mock `itsm` MCP server. Deterministic and
extractive in v0 (no model calls) — the governance is the point: this is the
platform's first agent that performs **gated writes**.

## Capabilities

| Capability | Risk | Tool(s) | Notes |
| --- | --- | --- | --- |
| `change.conflict_check` | R0 | `calendar_conflicts` | Scheduled/freeze overlaps for a window; abstains beyond the calendar coverage horizon. |
| `change.draft` | R1 | `change_create_draft` | Creates a draft; returns the assigned `change_id`. |
| `change.submit` | R2 | `change_submit` | Submits a draft for approval. Compensator: `change.withdraw`. |
| `change.withdraw` | R2 | `change_withdraw` | Withdraws a submitted change. Compensator: `change.submit` (mutual pair). |

The R2 pair `change.submit ⇄ change.withdraw` satisfies the registration
rules (compensator in-manifest, non-self, risk R1/R2). `change.withdraw`
accepts either a direct `change_id` or the compensator convention
`{original: {step_id, capability, input, output}}` — during a saga unwind the
orchestrator dispatches it with the original submit's recorded output.

## Governance mechanics (why this agent exists)

- **Idempotency**: every write passes `idempotency_key = ctx.stepId`
  (plan-minted, stable across activity retries), so a redelivered tool call
  never double-applies (`src/tools.ts` `idempotencyKey`).
- **Risk classes**: the tool gateway refuses an R2 tool call unless the
  step's signed `capability` claim declares risk ≥ the tool's risk, and the
  Cedar pair-policy requires an approval (or compensation) grounds bound to
  the step. `change.submit`/`change.withdraw` cannot execute on a bare
  R2-scoped token — a human must approve first (or it must be a saga unwind).
- **No LLM**: answers are templated from tool data and cited against the
  change log / calendar documents; abstention (`change.conflict_check` beyond
  coverage) is a success mode, never a confident guess.

## Environment

| Variable | Default |
| --- | --- |
| `ACP_TOOL_SERVER_ITSM_URL` | `http://localhost:7106/mcp/itsm` |
| `ACP_AGENT_CLIENT_ID` / `_SECRET` | `agent-change-agent` / dev secret |
| `ACP_TOKEN_URL` | `http://localhost:7101` |

## Evals

`evals/golden` (10 cases) and `evals/redteam` (4) run hermetically over a
shared in-memory `ItsmStore` (`src/fixture-tools.ts`) — the same mock the dev
platform serves. `evals/baseline.json` is the committed baseline the
evaluation service gates candidate reports against; regenerate it when the
golden suite changes (the suite digest is gated exactly).
