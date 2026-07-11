# Standard: Review Practices

Review is the platform's cultural control surface. The bar: **a reviewer is
accountable for what they approve** — approvals are engineering judgments,
recorded as such.

## What Gets Reviewed Like What

| Artifact | Review bar | Approvals |
|---|---|---|
| Service/SDK code | correctness, tests, standards | 1 maintainer |
| Protocol schemas (`packages/protocol`) | cross-language impact, migration path | 2, incl. one from each SDK's owners |
| Agent code + prompts | [agent-patterns checklist](agent-patterns.md) | 2, incl. owning team |
| Capability manifests | scope, risk class, compensators | 2; risk-class increase → owning team lead + platform maintainer |
| Cedar policies | tested allow/deny cases, blast radius | 2; the most privileged change type on the platform |
| Tool server contracts | [tool-integration rules](tool-integration.md), wrapped-system safety | 2, incl. system-of-record owning team |
| ADRs, standards docs | soundness, alternatives honestly weighed | 2 maintainers + 7-day comment window |
| Golden datasets / rubrics | representativeness, judge calibration | 1 + Evaluation Service owner for gate-affecting changes |

## Prompt and Manifest Review

Prompts and manifests are the highest-leverage, lowest-visibility diffs on
the platform, so tooling makes them reviewable:

- CI renders a **semantic diff** for manifest changes: capabilities
  added/removed, scopes widened, risk classes changed, model classes
  changed — reviewers see the governance delta, not YAML noise.
- Prompt PRs auto-attach the **eval delta**: baseline vs candidate scores
  per capability, cost delta, and sample transcripts for regressed cases.
  Reviewing a prompt without its eval evidence is reviewing blind — the PR
  template makes the evidence unavoidable.
- Scope-widening rule: any diff that grants an agent more (new tools, wider
  scopes, higher risk class) is called out by CI as **privilege escalation
  review** and cannot be self-approved by the authoring team alone.

## Review Culture

- Review the change, not the author; comments state the concern and the
  suggested direction; blocking comments distinguish "must fix" from
  "consider."
- Reviewers run the acceptance evidence when it's cheap (eval reports,
  scenario traces are attached — read them).
- **Small PRs are a standard, not a preference:** one logical change;
  agent behavior changes separate from refactors; schema changes separate
  from consumers where a deprecation window allows.
- Time-to-first-review target: 1 business day; stale PRs escalate to the
  area owner rather than rotting.
- Disagreements that outlive a PR thread become ADR discussions —
  decisions get recorded, not re-litigated per PR.

## AI-Assisted Development

Dogfooding is expected — agents and AI tooling writing platform code is
normal here. The rules:

- The human who opens the PR owns it: AI-generated code gets the same review
  bar, and "the model wrote it" is never a defense in review.
- AI reviewers may comment (and we encourage a review-agent as an early
  platform consumer) but **may not approve**; approval counts are human.
- Generated code that nobody on the team can explain fails review by
  definition.

## Release Review

- Release PRs (release-please) are reviewed for changelog accuracy —
  the changelog is user-facing documentation.
- Breaking changes require: migration notes in the changelog, a deprecation
  window per the versioning policy, and a communication entry in the release
  announcement draft.
