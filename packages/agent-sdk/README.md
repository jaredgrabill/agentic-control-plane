# @acp/agent-sdk

The TypeScript agent SDK for the Agentic Control Plane — the twin of the Python
`acp-agent-sdk`, with identical runtime semantics (the cross-SDK parity gate in
`tests/parity` holds both to the same golden verdicts).

One agent = manifest + handlers + tool bindings + eval suite. You never touch
transport: work arrives as Temporal activities on the agent's task queue, and
the SDK owns the polyglot `execute_capability` contract with the orchestrator.

- **Agent** — binds a validated `manifest.yaml` to capability handlers;
  `execute()` validates the StepRequest, enforces the declared `output_schema`
  with one structured-repair retry, and returns typed StepResults.
- **CapabilityContext** — everything a handler may touch: tenant/task/step
  identity, the governed model seam, citation-carrying retrieval under the
  step's delegated identity, a trace-correlated logger.
- **AnswerBuilder** — text + citations + confidence, abstention as a success
  mode below the confidence floor.
- **CapabilityError / ErrorClass** — typed failures; only `retryable` re-raises
  as a retryable activity failure.
- **FakeModel** — the deterministic test seam; exhausting the script fails loudly.
- **EvalHarness / loadGolden** — the golden-set runner; suites gate registration.
- **serveAgent (Agent.run())** — Temporal worker bootstrap with OTel interceptors.

## Quickstart

```ts
import { Agent, CapabilityError, ErrorClass } from '@acp/agent-sdk';

const agent = Agent.fromManifest('manifest.yaml');

agent.capability('notes.hello', async (ctx, input) => {
  const audience = String(input.audience ?? '');
  if (audience === '') throw new CapabilityError(ErrorClass.NeedsInput, 'audience is required');
  const builder = agent.answerBuilder();
  builder.paragraph(`Hello, ${audience}!`);
  return { ...builder.build(0.99) };
});

await agent.run(); // serves the `agent-<id>` task queue
```

Scaffold a compliant agent (manifest, handler, evals, tests) with
`@acp/create-agent`. Run the eval gate with `EvalHarness` + `loadGolden` —
see the generated `tests/evals.test.ts`.
