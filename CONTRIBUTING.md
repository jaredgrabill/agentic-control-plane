# Contributing

Thanks for your interest in contributing! This project is in its **design
phase**: the repository currently contains the platform architecture, standards,
and roadmap. Contributions at this stage are primarily design reviews, ADR
discussions, and roadmap feedback. Implementation contributions begin once the
architecture is approved (see [ROADMAP.md](ROADMAP.md)).

## Ground Rules

- Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- All contributions are licensed under the [MIT License](LICENSE). By
  submitting a pull request you agree your contribution is MIT-licensed
  (inbound = outbound; no CLA).
- Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## How to Contribute (Design Phase)

1. **Discuss first for substantive changes.** Open a GitHub Discussion or issue
   before proposing changes to architecture or standards documents.
2. **Architecture decisions require an ADR.** Any change to a technology
   choice, protocol, or cross-cutting pattern needs a new or superseding ADR in
   [docs/adr/](docs/adr/). Use the template in `docs/adr/README.md`.
3. **Small fixes** (typos, clarity, broken links) can go straight to a PR.

## Pull Request Process

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and PR titles (`feat:`, `fix:`, `docs:`, `chore:`, ...). Releases
  and changelogs are automated from these.
- Keep PRs focused: one logical change per PR.
- PRs require one maintainer approval; changes to ADRs or standards documents
  require two.
- CI must be green. During the design phase CI runs markdown lint, link
  checking, and spell checking. Code phases add the full quality gates defined
  in [docs/standards/testing.md](docs/standards/testing.md).

## Code Contributions (Post-Design Phase)

When implementation begins, the following apply (defined in detail under
[docs/standards/](docs/standards/)):

- **Python** (agent runtime, SDK): `uv` for env/deps, `ruff` for lint+format,
  `mypy --strict` for types, `pytest` for tests.
- **TypeScript** (control-plane services, SDK, UI): `pnpm` workspaces,
  `eslint` + `prettier`, `tsc --noEmit` strict mode, `vitest` for tests.
- New agents must ship with an evaluation suite and a capability manifest —
  see [docs/standards/agent-patterns.md](docs/standards/agent-patterns.md).
- Test coverage may not decrease; behavior changes require tests that fail
  without the change.

## Developer Certificate of Origin

We use the [DCO](https://developercertificate.org/). Sign off your commits with
`git commit -s`.
