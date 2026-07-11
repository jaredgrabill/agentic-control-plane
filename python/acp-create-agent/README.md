# acp-create-agent

Scaffolds a compliant ACP Python agent — the fastest way to build an agent
is the compliant way (agent-patterns.md).

```
uvx acp-create-agent my-agent
cd my-agent
uv run pytest        # the scaffolded golden set passes out of the box
uv run python -m src.main   # serve against the dev stack
```

The template ships the full anatomy: `manifest.yaml`, one working
capability handler, a four-bucket golden dataset seed, and eval-gated
tests. Replace the hello capability with your domain and keep the shape.
