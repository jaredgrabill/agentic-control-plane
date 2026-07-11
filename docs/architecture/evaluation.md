# Evaluation

Trust is earned continuously. Evaluation is not a launch gate — it is a
permanent control loop wired into CI, deployment, and production traffic.
Research basis: [observability-eval-cost brief](../research/observability-eval-cost.md).

## The Eval Contract

**No eval suite, no registration.** Every agent ships a versioned eval suite
alongside its manifest:

- **Golden dataset**, four buckets: production samples (once they exist),
  adversarial cases, edge cases, and replayed failures. Curated, versioned,
  grown over the agent's life — every production incident adds a case.
- **Scoring rubric** per capability: deterministic checks where possible
  (schema validity, citation resolvability, abstention correctness) and
  LLM-judge rubrics where judgment is required.
- **Red-team cases**: injection, extraction, tool-abuse attempts specific to
  the agent's tools.
- **Baselines**: the scores the current active version achieves; gates are
  relative to baseline, not absolute vibes.

Domain-specific gated metrics matter more than generic "quality": the
Knowledge agent gates on citation precision and abstention behavior; the
Change agent on conflict-detection recall; NetSec on zero false-negatives
for exposure regressions in its golden set.

## Judge Discipline

LLM-as-judge is a measurement instrument and gets calibrated like one:

- Judges are **calibrated against human annotations** (target ≥ 85–90%
  agreement) before their scores gate anything; calibration sets are
  maintained and re-run when the judge's model changes.
- **One rubric, two venues:** the same judge template scores offline golden
  sets and online sampled traffic, so offline and online numbers are
  comparable — an offline gate that doesn't predict production is
  measurement theater.
- Judge prompts/versions are registry artifacts; judge changes re-baseline
  affected agents.

## The Pipeline: Five Gates

Every agent change (prompt, model, tool binding, code) passes:

```
1. static checks     lint, schema validation, manifest diff review
2. offline evals     golden set ≥ baseline − tolerance; red-team suite green
3. cost check        projected cost/task within budget envelope
4. shadow            mirrored production traffic, side effects suppressed,
                     paired judge comparison vs incumbent over soak window
5. canary            live fraction, session-pinned, auto-ramp 5→25→50→100
                     with quality/cost/latency gates at each step,
                     auto-rollback on breach
```

Gates 4–5 are the Deployment Controller's `DeploymentWorkflow`
([agent-lifecycle.md](agent-lifecycle.md)); gates 1–3 run in CI. The
promotion decision is recorded with the eval evidence attached — an audit
artifact.

## Online Evaluation

- **Sampled scoring:** ~5–10% of production traffic scored by calibrated
  judges + guardrail classifiers; rate is per-agent config (higher for new
  or R2-capable agents).
- **Synthetic probes:** known-answer canary prompts run continuously against
  every active agent — liveness for *fitness*, catching silent degradation
  from provider model drift, tool API changes, or corpus rot.
- **Drift detection:** query/response embeddings + judge scores logged per
  trace; alerts on the joint condition (input drift **and** score drop).
  Behavioral drift — shifts in tool-selection patterns per capability — is
  monitored as its own signal.
- **Human feedback** (thumbs, approver overrides, escalations) joins judge
  scores in the quality SLI.

**Degradation responses are automatic and graduated:** score dip → alert
owner; sustained breach → quality error budget burns, changes freeze;
severe breach → routing weight demoted; SLO-defined floor → auto-suspend
(kill switch tier 1) and page.

## Closing the Loop

- Every online failure (bad judge score, human override, incident) is
  **one click from becoming a golden-set case** — the flywheel that makes
  gate 2 keep predicting production.
- **Replay as regression testing:** candidate versions re-run real historical
  tasks (from the audit trail, side effects suppressed) — the strongest
  pre-production signal we have, and the same machinery as compliance
  replay.
- Quarterly: eval-suite review per agent (do the buckets still represent
  traffic?), judge recalibration, red-team refresh against the current OWASP
  ASI list.

## Cross-Agent Evaluation

Composition is evaluated end-to-end, not just per agent: the acceptance
scenarios in [domains.md](../domains.md) are standing E2E evals with their
own golden sets and gates. A change to *any* participating agent runs the
composition suites it appears in — catching the failure mode where every
agent passes its own evals and the composed answer is still wrong.

## Status: v0 implementation

What exists today versus the target above:

- **`apps/evaluation` (@acp/evaluation)** — the offline gate as a CLI, not
  yet a long-running service: `run` executes every agent on the
  `agents.json` roster (each agent's SDK harness emits an
  `acp-eval-report/v1` document), `gate` applies baseline-relative
  tolerance math, `baseline` distills an accepted report into
  `<agent>/evals/baseline.json`, and `record` writes the baseline onto the
  registry's agent card (`PUT /v1/agents/:id/baseline`, audited as
  `agent.baseline_recorded`).
- **Protocol**: `eval-report.schema.json` pins the report and baseline
  shapes; the agent card's `eval_baseline` field now references them.
  Reports carry a `suite.digest` (sha256 over the golden files, identical
  across both SDKs), so the gate refuses to compare metrics across
  different suites — a golden-set change forces a re-baseline in the same
  PR.
- **CI**: the `evals` job runs the roster on every PR (deterministic,
  hermetic suites only) plus an inverted step proving the gate rejects a
  committed regressed-report fixture — the gate itself is gated.
- **Gate 2 only.** Deterministic metrics (pass rate, citation precision,
  abstention accuracy) from the SDK EvalHarness; the knowledge agent gates
  at zero tolerance because its suite is fully deterministic. Judge
  rubrics, calibration, shadow/canary (gates 4–5), online sampling, drift
  detection, and replay arrive with the Deployment Controller (Phase 3).
