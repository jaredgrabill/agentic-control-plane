# Contributing

Thanks for your interest in contributing! The project is past its design phase
and in active implementation: a running control plane (token, gateway,
registry, Cedar policy, Temporal orchestrator, audit, knowledge/RAG, tool and
LLM gateways, evaluation) plus TypeScript and Python agent SDKs and reference
agents. This guide covers building, testing, and the quality gates every change
must pass.

## Ground Rules

- Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- All contributions are MIT-licensed (inbound = outbound; no CLA). By opening a
  PR you agree your contribution is under the [MIT License](LICENSE).
- Sign off every commit under the [DCO](https://developercertificate.org/):
  `git commit -s`.
- Security issues go through [SECURITY.md](SECURITY.md) — never a public issue.

## Development Setup

Prerequisites: Node 22+, [pnpm](https://pnpm.io) 11, [uv](https://docs.astral.sh/uv/),
Docker (for the local substrate), and `make`.

```bash
make dev                 # substrate: NATS, Temporal, Postgres+pgvector, OTel, Jaeger
pnpm install && pnpm build
cd python && uv sync && cd ..
make platform            # run the control plane + reference agents locally
```

- `make dev` / `make dev-down` — bring the Docker substrate up / down.
- `make platform` — run the services + agents against the substrate.
- `make e2e` — the exit-scenario end-to-end test (needs `make dev` up).

## Quality Gates (run before you push)

CI runs these; run them locally first. `make lint` and `make test` wrap the
common ones.

**TypeScript** (`pnpm` workspaces, `tsc` strict, `eslint` + `prettier`,
`vitest`):

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
```

**Python** (`uv`, `ruff`, `mypy`, `pytest`, coverage floor 85%):

```bash
cd python && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest --cov --cov-fail-under=85
```

**Cross-cutting gates:**

- **Contracts / codegen.** Any change under `packages/protocol/schemas` requires
  `pnpm gen`; commit BOTH the TypeScript and Python bindings in the same PR (the
  `contracts` gate diff-checks them). The audit-event enum is **append-only** —
  regenerate, never hand-edit.
- **Parity.** The TypeScript and Python SDKs must agree case-by-case on the
  golden fixtures (`parity` gate).
- **Evals.** New agents ship with a golden eval suite and a capability
  manifest; the `evals` gate holds every roster agent within tolerance of its
  committed baseline. Add a new agent to `apps/evaluation/agents.json` **and**
  the evals-job build filter list in `.github/workflows/ci.yml`.
- **API freeze / SemVer.** Changes to the public protocol or SDK surface are
  governed by [docs/standards/api-versioning.md](docs/standards/api-versioning.md)
  and enforced by the `api-freeze` gate — see below.
- **Coverage never decreases; behavior changes need a test that fails without
  the change.**

Turbo caches test results — before you push, force a clean run so a green local
cache can't mask a failure CI will catch:

```bash
pnpm turbo run test --force
```

## SemVer and API Stability

The public wire contract (protocol JSON Schemas + NATS subjects) and the
published SDK packages are frozen under Semantic Versioning at 1.0. The full
policy — what is public, the additive-vs-breaking rules, the append-only audit
enum, and the deprecation process — is in
[docs/standards/api-versioning.md](docs/standards/api-versioning.md).

Two gates enforce it:

- `node scripts/schema-diff.mjs` classifies wire-contract changes; a breaking
  change fails CI unless the PR carries the **`breaking`** label, the version is
  a major bump, and the baseline is regenerated
  (`node scripts/schema-diff.mjs --write-baseline`).
- `node scripts/api-report.mjs --check` fails if a public SDK export changed
  without regenerating the committed API report (`pnpm api:report`).

## Proposing Changes

- **Small fixes** (typos, clarity, bugs with a test) — open a PR directly.
- **Architecture decisions** (a technology choice, protocol change, or
  cross-cutting pattern) require an **ADR** in [docs/adr/](docs/adr/) — use the
  template in [docs/adr/README.md](docs/adr/README.md).
- **Substantive, cross-cutting, or trust-boundary changes** go through the
  **RFC** process first — see [docs/rfc/README.md](docs/rfc/README.md). An
  accepted RFC is distilled into an ADR.

Decision-making (lazy consensus, approvals, the steering group) is described in
[GOVERNANCE.md](GOVERNANCE.md).

## Pull Request Process

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and PR titles (`feat:`, `fix:`, `docs:`, `chore:`, …). Keep subject
  lines lowercase and ≤ 72 characters (commitlint enforces this). Releases and
  changelogs are automated from these via release-please.
- Keep PRs focused: one logical change per PR.
- PRs require one maintainer approval; changes to ADRs, standards documents, or
  the frozen API surface require two.
- CI must be green.
