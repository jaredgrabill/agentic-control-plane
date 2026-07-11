# acp-agent-sdk (alpha)

The paved road for Python agents: build a compliant agent in a handful of
lines, and the platform does governance, telemetry, and evaluation for you.

```python
from acp_agent_sdk import Agent

agent = Agent.from_manifest("manifest.yaml")

@agent.capability("knowledge.answer_with_citations")
async def answer(ctx, input):
    results = await ctx.retrieve(input["question"], k=6)
    builder = agent.answer_builder()
    n = builder.cite(results[0]["citation"])
    builder.paragraph(f"{results[0]['content'].splitlines()[0]} [{n}]")
    return builder.build(confidence=results[0]["score"] * 10)

if __name__ == "__main__":
    import asyncio
    asyncio.run(agent.run())
```

- **Handlers are stateless**: everything arrives in the `CapabilityContext`.
- **`ctx.retrieve`** is the only door to the corpus — citation-carrying,
  policy-checked, audited.
- **`ctx.model`** is the only door to LLMs; tests script it with `FakeModel`.
- **`AnswerBuilder`** makes citations and abstention the easy path.
- **`EvalHarness`** runs your golden set locally and in CI identically.

Scaffold a new agent with `uvx acp-create-agent my-agent`.
