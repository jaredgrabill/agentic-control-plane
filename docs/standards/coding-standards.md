# Standard: Code Quality and Repository Layout

## Monorepo Layout

```
agentic-control-plane/
├── apps/                    # deployable control-plane services (TypeScript)
│   ├── gateway/
│   ├── registry/
│   ├── policy/
│   ├── orchestrator/        # Temporal workflows
│   ├── deployment/
│   ├── evaluation/
│   └── audit/
├── packages/                # shared TypeScript libraries
│   ├── agent-sdk/           # @acp/agent-sdk
│   ├── protocol/            # schemas: manifests, task contracts, events
│   ├── service-kit/         # shared control-plane service runtime
│   ├── telemetry/
│   └── create-agent/        # TS scaffolder
├── python/                  # uv workspace
│   ├── acp-protocol/        # generated Pydantic bindings of packages/protocol
│   ├── acp-agent-sdk/
│   ├── acp-create-agent/
│   └── agents/              # reference agents (knowledge, netsec, ...)
├── agents/                  # TypeScript reference agents (cloud, code)
├── deploy/                  # docker-compose dev stack, helm charts
├── docs/
└── .github/
```

- TypeScript: **pnpm workspaces + Turborepo**. Apps never import from apps;
  shared code lives in `packages/`.
- Python: **uv workspace**, single lockfile, packages under `python/`.
- **`packages/protocol` is the single source of truth for cross-language
  contracts**: JSON Schema / OpenAPI definitions from which TypeScript types
  (generated) and Pydantic models (generated) both derive. Hand-maintained
  parallel types are banned — schema drift between the SDKs is the platform's
  version of undefined behavior.

## TypeScript

- `tsc` strict mode, no `any` escapes without a lint-suppressed justification
  comment; ESLint (flat config) + Prettier; `vitest` for tests.
- Node LTS; ESM only.
- Public APIs of `packages/*` carry TSDoc; `@acp/agent-sdk` docs are
  generated and published per release.
- Temporal workflow code follows determinism rules mechanically (no
  Date.now/Math.random/IO in workflows — enforced by the Temporal ESLint
  plugin and the isolate at runtime).

## Python

- ≥ 3.12; `ruff` (lint + format), `mypy --strict` on `src/`; `pytest`.
- Pydantic v2 models generated from `packages/protocol` schemas.
- `structlog` JSON logging via the SDK; `async` throughout the agent
  runtime (activities are async; blocking calls go through
  `asyncio.to_thread`).

## Both Languages

- **Conventional Commits** enforced by commitlint in CI; releases and
  changelogs automated with **release-please** (manifest mode covering node
  and python packages together).
- SemVer on every published package: `@acp/*` (npm) and `acp-*` (PyPI)
  release in lockstep for protocol-affecting changes.
- Secrets never in code or config files — env/vault injection only;
  `.env.example` documents required variables; secret scanning in CI.
- Feature flags via the platform control KV, not env vars, so flips are
  audited and don't require redeploys.
- Error messages state what failed, with which inputs (redacted), and what
  the caller can do — they are operator UX, reviewed as such.
- Comments explain constraints and non-obvious *why*; changelog-style or
  narration comments are rejected in review.

## Definition of Done (any PR)

1. CI green: lint, types, tests, coverage non-decreasing.
2. Behavior changes carry tests that fail without the change.
3. Contract changes regenerate both language bindings in the same PR.
4. Agent-affecting changes: eval gates per [evaluation.md](../architecture/evaluation.md).
5. Docs updated when behavior or interfaces changed.
6. Conventional Commit title; two approvals where the area requires it
   (ADRs, standards, policies, manifests).
