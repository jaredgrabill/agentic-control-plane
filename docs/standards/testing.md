# Standard: Testing

Agentic systems have two failure surfaces: the **software** (deterministic,
testable classically) and the **behavior** (stochastic, testable with evals).
Both are gated; confusing the two — testing prompts with unit tests or
testing code with vibes — is the anti-pattern this standard exists to stop.

## The Pyramid, Adapted

```
        E2E scenario evals          (few; the acceptance scenarios)
      composition/workflow tests    (Temporal test env, mocked agents)
    agent behavior evals            (golden sets per capability)
  contract tests                    (protocol schemas, tool servers)
unit tests                          (handlers, services, utilities)
```

### Unit tests (deterministic code)

- Everything that doesn't call a model: parsing, routing logic, policy
  helpers, cost math, schema utilities. Coverage floor 85% on control-plane
  services and SDKs; coverage may never decrease.
- **LLM calls are faked at the SDK seam** — the SDK ships a `FakeModel`
  (scripted responses, recorded fixtures) so handler logic (tool selection
  arms, error paths, budget behavior) unit-tests deterministically.

### Contract tests

- `packages/protocol` schemas have round-trip tests in **both** languages
  against shared fixture files — the same bytes must parse identically in
  TypeScript and Python.
- Tool servers: recorded-interaction tests against wrapped-system sandboxes
  ([tool-integration.md](tool-integration.md)); breaking-change detection
  on every schema diff in CI.

### Workflow tests

- Temporal's test environments (time-skipping) cover every workflow:
  happy paths, every failure class in the taxonomy, approval timeout →
  deny, compensation unwind order, continue-as-new state carriage,
  cancellation mid-step.
- Agents are mocked at the activity boundary — workflow tests verify
  orchestration semantics, not agent intelligence.

### Behavior evals (the stochastic surface)

- Golden datasets per capability, four buckets (production, adversarial,
  edge, replayed failures); rubrics deterministic-first, calibrated judges
  second ([evaluation.md](../architecture/evaluation.md)).
- Run in CI on every agent-affecting change against pinned models with
  fixed decoding params; scored against stored baselines with explicit
  tolerance. **Eval flake is treated like test flake** — a rubric whose
  score wobbles beyond tolerance on identical inputs gets fixed, not
  rerun-until-green.
- Red-team suites (injection, extraction, tool abuse) are blocking, same as
  any other test.

### E2E scenario evals

- The cross-domain acceptance scenarios ([domains.md](../domains.md)) run
  against a full dev-stack deployment (docker-compose: NATS, Temporal,
  Postgres, mocked enterprise systems) nightly and before any release.
- Verify the *platform* properties, not just the answer: full trace
  present, citations resolve, policy decisions logged, cost attributed,
  budgets respected.

## Test Data Discipline

- No production data in test fixtures; synthetic corpora ship with the repo
  (a fake enterprise: policies, CMDB, firewall rules, repos — the
  `fixtures/acme-corp` dataset) so contributors and CI never need real
  systems.
- Mock tool servers for every reference integration live in `deploy/mocks`
  — they implement the same MCP contracts and the same error taxonomy,
  including scripted failure modes (rate limits, timeouts, partial data).

## Fault Injection

Robustness is tested, not hoped for. The SDK test harness scripts failure
scenarios at each seam and runs them as a **standing CI suite** for every
agent:

- **Model faults** (via FakeModel): malformed JSON, schema-invalid output,
  refusals, mid-stream truncation, provider timeouts and 429s.
- **Bus faults**: dropped replies, delayed delivery, duplicate delivery
  (consumers must be idempotent by standard).
- **Tool faults** (via mock servers): invalid responses, partial data,
  contract-version skew, rate-limit storms.
- **Governance faults**: policy denials mid-plan, approval timeouts,
  kill-switch mid-task — verifying compensation unwinds and honest
  partial-result reporting, not just happy paths.

Expected behavior under each fault is asserted (typed error, retry, degrade,
or clean abort per the [error taxonomy](agent-patterns.md)) — "didn't
crash" is not a passing grade.

## CI Topology

| Trigger | Runs |
|---|---|
| every PR | lint, types, unit, contract, workflow tests, affected-package selection via turbo/uv |
| agent-affecting PR | + behavior evals (gates 1–3 of the [pipeline](../architecture/evaluation.md)) + red-team |
| nightly | E2E scenarios on dev stack; tool contract tests vs sandboxes; OpenSSF Scorecard |
| release | full suite + E2E + docs build + package publish dry-run |

Flaky tests are quarantined within 24h and fixed or deleted within a week —
a quarantine list with owners, not a culture of rerunning.
