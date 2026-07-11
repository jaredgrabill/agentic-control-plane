# Project Governance

This document describes how the Agentic Control Plane project is governed as
an open-source project. (Runtime governance of agents — policy, guardrails,
audit — is a platform feature, documented in
[docs/architecture/governance-and-policy.md](docs/architecture/governance-and-policy.md).)

## Roles

- **Users** — anyone deploying or evaluating the platform. Feedback via issues
  and discussions is a first-class contribution.
- **Contributors** — anyone with a merged PR or accepted design input.
- **Maintainers** — contributors with merge rights, listed in
  [CODEOWNERS](.github/CODEOWNERS). Maintainers review PRs, triage issues,
  steward ADRs, and cut releases.
- **Steering group** — 3–5 maintainers who resolve escalations and approve
  changes to project scope, licensing, and this document.

## Decision Making

- Default: **lazy consensus**. Proposals (issues, ADR PRs) that receive no
  objection from a maintainer within 7 days are accepted.
- Architecture decisions: recorded as ADRs in [docs/adr/](docs/adr/); require
  two maintainer approvals.
- Escalation: if consensus fails, the steering group decides by majority vote.

## Becoming a Maintainer

Sustained, high-quality contribution (code, docs, review, triage) over roughly
three months, nominated by an existing maintainer and confirmed by lazy
consensus of the maintainer group.

## Releases

- Semantic versioning across all published packages.
- Conventional Commits drive automated changelogs and release PRs.
- Pre-1.0: breaking changes allowed in minor versions, always flagged in the
  changelog with migration notes.

## Changes to Governance

Changes to this document require steering-group approval and a 14-day comment
period.
