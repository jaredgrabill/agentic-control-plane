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

**v0 gate math (Phase 3 item 4).** The `GateEvaluator` is deterministic and
audit-derived: the shadow gate joins `deployment.shadow_result` records to
their primary `step.completed` on `(task_id, step_id)`; the canary gate folds
`step.completed` split by the executing agent version. It breaches on success-
ratio delta, p95 latency ratio, or cost/step ratio (cost only when both
versions are priced by the Cost Meter book) — the **audit stream is the
comparison store**. Paired *judged quality* is **not** in v0: `GateReport`
carries an optional `metrics.quality` field that item 6's calibrated judge
fills, consuming the same `shadow_result` records behind the same
`GateEvaluator` interface. The `DeploymentWorkflow`'s breach logic is
metric-agnostic (it treats any populated metric uniformly), so item 6 swaps the
evaluator implementation, not the workflow.

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

## Online Evaluation v0 (Phase 3 item 6)

The measurement instruments the target above describes now run online — a
calibrated judge, synthetic probes, drift detection, and quality error
budgets wired to real change-freezes and a degradation ladder.

- **Judge harness (`@acp/judge`).** One committed rubric
  (`answer-quality@1`), one prompt template used by BOTH venues
  (`buildJudgePrompt` — "one rubric, two venues" enforced structurally), a
  tolerant verdict parser (first balanced JSON object, Ajv-validated, score
  clamped to [0,1] with the verdict recomputed from the 0.7 threshold), and a
  **fail-closed calibration gate**. A judge scores NOTHING until a calibration
  record — keyed on `{rubric_digest, model_class}` — proves agreement with
  labels at/above the floor (0.85). A rubric edit or model-class swap
  invalidates the record and the judge REFUSES to score (no LLM call). Every
  `eval.score` carries the `rubric_digest` so a replay proves which exact
  rubric produced a verdict.
  - **Honest dev calibration.** `calibration/answer-quality@1/cases-dev.json`
    embeds scripted `[[dev-llm]]` verdicts so the dev-echo provider yields
    agreement 1.0. The committed `calibration.dev.json` proves the
    calibration MACHINERY (rubric → prompt → parse → agreement) end to end —
    it is deliberately NOT a judgement of a real model. **Real calibration
    needs human-annotated cases scored by a real provider and is deferred to
    provider onboarding.** The `calibrate` CLI (`apps/evaluation`) measures
    agreement against a labelled set and exits 1 below the floor.
- **Judge failures are never agent observations.** An uncalibrated judge,
  a gateway error (`judge_error`), or an unreadable completion
  (`unparseable_verdict`) is a JUDGE condition — audited for visibility but
  INGESTING NOTHING, so a broken judge can never burn an agent's error
  budget. A hard step failure IS a quality observation (`failed_step`,
  `passed:false`, no LLM call).
- **Sampled online scoring.** `resolveRoute` samples each step
  deterministically per `(task_id, step_id)` — independent of the version
  bucket, boosted to always-on during a shadow soak so the incumbent is
  judged paired with the candidate. A sampled step spawns a
  `JudgeScoreWorkflow` with `ParentClosePolicy.ABANDON`, never awaited, so a
  slow or failing judge cannot touch the step's latency or outcome. Scoring
  happens at step completion — the only place the full output exists (audit
  keeps digests only). `ShadowStepWorkflow` scores the shadow output too;
  **shadow-route scores feed ONLY the deployment gate, never the production
  budget.** The judge's own LLM usage is a `model.invoked` with
  `purpose:'judge'` — priced by the Cost Meter (platform cost center) but
  never counted against the tenant task budget.
- **Synthetic probes (`ProbeWorkflow`).** A singleton (`synthetic-prober`)
  runs every configured known-answer probe through a REAL `TaskWorkflow`
  child each cycle — the real trust path minus intake (a freshly-minted
  svc-prober subject token → planner → Cedar → broker → agent). Checks are
  deterministic and **judge-INDEPENDENT**, so probe signal survives an
  unhealthy judge. It warns on active agents without probe coverage so
  "every active agent is probed" is visible, not silently false. Probes hit
  the ACTIVE version only. Runner-on-Temporal, brain-in-eval-service is a
  documented deviation from agent-lifecycle's "Evaluation Service runs
  probes".
- **Scores service (`apps/evaluation serve`, port 7108, aud `acp:eval`).**
  A Postgres+pgvector scores store and the single enforcement brain. Every
  ingest recomputes the **error budget from the window** — there is no
  sticky freeze; it self-heals as the window slides. Below `min_samples`
  weighted observations the budget is `ok` (a budget that cannot measure
  does not freeze — the deliberate inverse of the calibration gate).
  `burn_ratio = bad_weighted / (total_weighted × (1 − SLO))`; SLO is the
  manifest's `sla.quality_slo ?? 0.9`.
- **Drift v0** over the shared `dev-hash-embed@1` embedding (a weak but
  genuine lexical statistic, model-swappable). Per `(agent, capability)`, an
  alert fires ONLY on the JOINT condition — input drift AND a score drop —
  with a per-pair cooldown. Drift is alert-only; the budget rungs act on the
  score independently. Behavioral (tool-selection) drift is deferred.
- **Degradation ladder → real mechanisms.** On every ingest: a score dip →
  `warning` (alert the owner); a burned budget → `exhausted` (change-freeze,
  pull-enforced); sustained failure → `severe` (abort an in-flight
  deployment via the item-4 API — a solo active version has no lateral
  demote, an honest v0 limit); the SLO floor → auto-suspend = kill switch
  tier 1 (`registry:suspend` → suspended) and page. Actions fire only on
  ENTERING a rung, so a deployment is aborted once, not every ingest.
- **Change freeze (fail-closed).** `DeploymentWorkflow` checks
  `checkQualityFreeze` as STEP 1 (before candidate validation — the freeze
  wins) and again before promotion. An exhausted budget refuses the
  deployment (`deployment.failed reason change_freeze`); an unreachable eval
  service ALSO refuses (`freeze_check_unavailable`) — matching the item-4
  gate posture. Unfreeze is window recovery only (no manual override in v0).
- **Deployment-gate quality (fills the item-4 seam).** The `GateEvaluator`
  folds paired judged-quality means fetched from the scores store by
  version+route+window — candidate on the shadow/canary route vs incumbent
  on active — into `GateReport.metrics.quality`, breaching when the candidate
  falls more than `max_quality_delta` below the incumbent. Too-few samples or
  an uncalibrated (null) mean omits quality, so the gate stays
  deterministic-only exactly as item 4 shipped. The `DeploymentWorkflow` is
  untouched by the fold.
- **New scope `registry:suspend`.** Valid ONLY on the `*→suspended` edge, so
  the automated SLO-floor sanction cannot become a general `registry:admin`
  capability. `svc-evaluation` holds `[registry:read, registry:suspend,
  deploy:write]`.
- **Protocol.** Four `eval.*` audit events (`eval.score`,
  `eval.probe_result`, `eval.drift_detected`, `eval.budget_state_changed`);
  `details` stays schema-open, so no other contract changed.
- **Deferred:** real human calibration + provider judging; judged metrics in
  the CI gate-2 (no gateway there); registry-stored judge artifacts;
  behavioral drift; golden-suite-as-probes; a routing-weight demote for a
  solo active version; human-feedback producers/UI; manual freeze override.
