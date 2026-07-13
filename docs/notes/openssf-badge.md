# OpenSSF Best Practices Badge — Criteria Tracker

This tracks the project against the [OpenSSF Best Practices Badge](https://www.bestpractices.dev)
(the CII BadgeApp **passing**-level questionnaire). It is **distinct** from the
OpenSSF **Scorecard** we already run in CI
([`.github/workflows/scorecard.yml`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/.github/workflows/scorecard.yml)):
Scorecard is an automated heuristic scan; the Best Practices badge is a
self-certified questionnaire that a human submits and maintains.

Legend: **MET** (evidence in-repo) · **GAP** (work needed) · **HUMAN** (a
person must act — see [What Jared must do](#what-jared-must-do)).

## Passing-level criteria

| Criterion | Status | Evidence |
|---|---|---|
| OSS license (OSI-approved) | MET | [`LICENSE`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/LICENSE) (MIT) |
| License in standard location | MET | `LICENSE` at repo root |
| Public version-controlled source | MET | GitHub, full history |
| Public issue tracker | MET | GitHub Issues + Discussions |
| Unique version numbering + SemVer | MET | [API versioning standard](../standards/api-versioning.md); release-please per-package versions |
| Release notes / changelog | MET | release-please changelogs per component |
| Contribution guide | MET | [`CONTRIBUTING.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/CONTRIBUTING.md) |
| Code of conduct | MET | [`CODE_OF_CONDUCT.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/CODE_OF_CONDUCT.md) |
| Documented governance / roles | MET | [`GOVERNANCE.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/GOVERNANCE.md) |
| Vulnerability reporting process | MET | [`SECURITY.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/SECURITY.md) (private GH advisory) |
| Security response time stated | MET | `SECURITY.md` (3-day ack, 10-day triage, 90-day disclosure) |
| Project uses HTTPS site | MET | docs site served over HTTPS (GitHub Pages) |
| Description of what the project does | MET | [`README.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/README.md) |
| Working build from source | MET | `make dev` + `pnpm build` + `uv sync`; [README quickstart](https://github.com/jaredgrabill/agentic-control-plane/blob/main/README.md) |
| Automated test suite | MET | `vitest` + `pytest`; e2e suite ([`.github/workflows/e2e.yml`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/.github/workflows/e2e.yml)) |
| Tests run on CI | MET | `ci` workflow (typescript, python, contracts, parity, evals, api-freeze) |
| New-functionality tests policy | MET | [testing standard](../standards/testing.md): coverage may not fall; behavior changes need failing-first tests |
| Static analysis | MET | `eslint` + `tsc --strict`, `ruff` + `mypy --strict`, CodeQL via Scorecard |
| Secret scanning | MET | `gitleaks` in the `security` CI job |
| Dependency vulnerability scanning | MET | `pnpm audit` + `pip-audit` in the `security` CI job |
| Warnings/lint clean (as CI gate) | MET | lint + format:check gate the build |
| Dynamic analysis / fault injection | MET | fault-injection + red-team suites ([threat model](../architecture/threat-model.md)) |
| Signed releases / provenance | GAP → HUMAN | signed-commit + DCO capability present; **release signing** = signed annotated tags (+ artifact attestation) — wire on the first tag; manual-signed-tag path documented in the [rolling-upgrade runbook](../runbooks/upgrade-rolling.md) |
| Crypto: TLS for network traffic | MET | HTTPS edge, TLS to Postgres/NATS in production; secrets are env/vault key **names** (`credential_ref`), never values |
| No leaked credentials | MET | `gitleaks` + `credential_ref` pattern (no secrets in config) |
| Badge registered + ID published | GAP → HUMAN | not yet submitted — see below |

## Known gaps

- **Release signing / provenance.** The repository supports signed commits and
  uses DCO sign-off. Release *artifact* signing (signed tags + build
  provenance/attestation) is wired at the first real tag; until the
  release-please Actions setting is enabled, 1.0 is cut as a manually-signed
  annotated tag (documented in the
  [rolling-upgrade runbook](../runbooks/upgrade-rolling.md)).
- **Badge submission itself is human-gated** — the questionnaire is
  self-certified on bestpractices.dev by a maintainer.

## What Jared must do

1. Register the project at <https://www.bestpractices.dev>, sign in with GitHub,
   and add this repository.
2. Answer the passing questionnaire — the table above maps every criterion to
   its evidence, so it is mostly transcription.
3. Copy the resulting **badge ID / markdown** into the top of
   [`README.md`](https://github.com/jaredgrabill/agentic-control-plane/blob/main/README.md).
4. When the first tag is cut, confirm it is a **signed** annotated tag so the
   "signed releases" criterion flips to MET.

The engineering side is complete to the point where only these human steps
remain.
