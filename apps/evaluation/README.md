# @acp/evaluation — Evaluation Service v0

The offline eval gate (gate 2 of [evaluation.md](../../docs/architecture/evaluation.md)):
a CLI-shaped service that runs each agent's golden suite through its SDK
harness, gates the fresh report against the **committed baseline**, and
records accepted baselines on the registry's agent card. Gates are
**baseline-relative** — golden set ≥ baseline − tolerance — never absolute
thresholds.

v0 is deliberately not a long-running service: no HTTP server, no Temporal
worker, no judge harness, no online sampling. Those arrive in Phase 3 with
the Deployment Controller; this package is the slot they grow in.

## CLI

Built to `dist/main.js` (run `pnpm --filter @acp/evaluation... build` first):

```sh
# Gate every agent on the roster (what CI runs on every PR)
node apps/evaluation/dist/main.js run --manifest apps/evaluation/agents.json

# Gate one report against one baseline (optionally with a gate.json)
node apps/evaluation/dist/main.js gate --report report.json --baseline baseline.json [--gates gate.json]

# Distill an accepted report into a committable baseline
node apps/evaluation/dist/main.js baseline --report report.json --out <dir>/evals/baseline.json

# Record a baseline on the registry card (svc-ci already holds registry:write)
node apps/evaluation/dist/main.js record --baseline <dir>/evals/baseline.json \
  --registry http://localhost:7102 --token-url http://localhost:7101 \
  --client-id svc-ci --client-secret ci-dev-secret
```

Exit 0 on pass; exit 1 with one violation per stderr line.

## The roster: agents.json

Each entry names an agent, its repo-relative directory, and the argv array
(no shell) that emits its `acp-eval-report/v1` document to `{out}`:

```json
{
  "schema": "acp-eval-agents/v1",
  "agents": [
    {
      "agent_id": "knowledge-agent",
      "dir": "python/agents/knowledge",
      "report_command": ["uv", "run", "--directory", "python", "python", "-m", "knowledge_agent.eval_report", "--out", "{out}"]
    }
  ]
}
```

Conventions per agent directory: golden suite at `<dir>/evals/golden/`,
committed baseline at `<dir>/evals/baseline.json` (required — no baseline,
no gate), optional per-metric tolerances at `<dir>/evals/gate.json`.
New agents (Phase 2 Item 3) plug in by adding a roster entry plus those
files.

## Suite identity and re-baselining

Reports carry a `suite.digest` — sha256 over the sorted golden `*.json`
files (basename NUL content NUL per file, CRLF→LF), computed identically by
both SDKs. When a PR changes the golden suite, the digest no longer matches
the committed baseline and the gate **stops instead of comparing metrics
across different suites**. The fix is part of the same PR:

```sh
uv run --directory python python -m knowledge_agent.eval_report --out /tmp/report.json
node apps/evaluation/dist/main.js baseline --report /tmp/report.json --out python/agents/knowledge/evals/baseline.json
```

…and commit the refreshed `baseline.json`, so the reviewer sees the metric
deltas alongside the golden-set change.

## Why not `manifest.sla.quality_slo`?

That is a single number and an *online* SLO for the deployment controller.
The gate needs per-metric CI tolerances relative to a recorded run — a
different object with a different lifecycle.

## Known v0 limits

- Re-registering an agent replaces its card and drops the recorded
  `eval_baseline` (registry debt #3 adjacent). Acceptable in v0: the
  committed `evals/baseline.json` is CI's source of truth; re-record with
  the `record` subcommand after re-registration.
- All metrics are assumed higher-is-better on [0, 1] (the
  acp-eval-report/v1 contract).
- The registry write is last-writer-wins; CI is the sole writer in v0.
