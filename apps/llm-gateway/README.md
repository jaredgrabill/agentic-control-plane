# LLM Gateway (Phase 3 Item 0a)

The one door from the platform to model providers (port **7107**). Agents
reach it through the SDK's `GatewayModel`; platform callers (judge harness,
planner, synthesis) use `@acp/llm-client`'s `GatewayClient` directly.

## The enforcement pipeline (src/core.ts)

1. **Kill switch** — fleet halt, then agent suspension for agent callers.
2. **Model-class lookup** — `acp-model-classes/v1`
   (`deploy/dev/model-classes.json`, env `ACP_MODEL_CLASSES`). Manifests
   declare classes, never model ids; rebinding is a config change.
3. **Model allowlist** — agent callers may only use classes in their
   registered card's `models.allowed` (30s-TTL registry cache, own
   `registry:read` credentials, **fail closed 503 on registry outage**).
4. **Prompt validation + stable-prefix assembly** — static ≤4 blocks,
   total ≤32, assembly strictly `static ++ variable`; the prefix digest
   feeds `acp.llm.prefix_digest` / `acp.llm.prefix_stable`.
5. **Failover loop** — ordered bindings, ≤ `max_attempts` per binding,
   full-jitter backoff (200ms·2^n, cap 2s), per-attempt `timeout_ms`, 60s
   overall deadline. `upstream_auth` fails over immediately; provider
   `invalid_input` refuses with no failover; all bindings terminally
   rate-limited → 429, anything else exhausted → 503. Temporal retries the
   whole activity when the gateway gives up (two-layer retry story).
6. **`model.invoked` audit + `llm.complete` span** — the span carries
   `gen_ai.usage.*` and is the Cost Meter's pricing record.

## Auth

`acp:llm` service tokens must hold `llm:invoke`; `acp:agent:{id}` delegated
tokens must satisfy the aud↔act.sub consistency check. No Cedar in v1 —
this PEP's job is the model allowlist plus what the token already caps.

## Providers

- **dev** (`providers/dev.ts`) — hermetic: `dev-echo@1` (deterministic
  echo; a `[[dev-llm]] <payload>` line in the variable text scripts the
  output through data), `dev-fail-429@1`, `dev-fail-500@1`. Simulates
  prompt-cache accounting (first prefix sighting bills cache_creation,
  repeats bill cache_read).
- **anthropic** (`providers/anthropic.ts`) — Messages API; ephemeral
  `cache_control` breakpoint on the last static block at ≥1024 estimated
  static tokens. Never exercised in dev/CI; unit-tested against a mocked
  fetch. Optional per-provider in-memory `rpm` bucket (off in dev).

## Wire surface

`POST /v1/complete`, `GET /v1/model-classes`, `GET /healthz`. Shapes and
error vocabulary live in `@acp/llm-client`.
