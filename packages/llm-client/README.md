# @acp/llm-client

Wire types, Ajv validators, and the HTTP client for the LLM Gateway
(Phase 3 Item 0a). Deliberately app-local shapes — not protocol schemas —
until a Python consumer appears; every TS participant (the gateway itself,
the SDK's `GatewayModel`, the judge harness, planners) shares this one
definition.

## Pieces

- **`CompletionRequest` / `CompletionResponse`** — the `POST /v1/complete`
  wire shapes. The prompt is block-structured with a hard static/variable
  split, so a cache-hostile volatile-before-static layout is inexpressible
  on the wire (cost-management.md lever 1).
- **`completionRequest` / `completionResponse` / `llmErrorBody`** — compiled
  Ajv validators. The gateway validates every inbound request; the client
  validates every 200 body.
- **`GatewayClient`** — `complete()` and `modelClasses()` with correlation
  headers and typed failures.
- **`LlmGatewayError`** — the closed error vocabulary on the wire:
  `invalid_input` (400), `unauthenticated` (401), `model_not_allowed` (403),
  `model_class_unknown` (400), `rate_limited` (429), `unavailable` (503),
  `killswitch` (503).

## Who calls what

Agents never construct a `GatewayClient`: they get the SDK's `GatewayModel`
(a `ModelClient`) bound to the step's delegated token. Platform callers
(judge harness, LLM planner, synthesis) use `GatewayClient` directly with an
`acp:llm` service token carrying `llm:invoke`.
