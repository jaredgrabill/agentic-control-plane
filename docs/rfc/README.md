# RFC Process

Most changes need no RFC: a focused PR, reviewed per
[CONTRIBUTING.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/CONTRIBUTING.md), is the norm. RFCs exist for the
minority of changes that are **substantive and cross-cutting** — where writing
the design down before the code saves a costly wrong turn and gives the
community a place to object early.

## When an RFC is required

Open an RFC when a change:

- alters the **wire contract** (protocol schemas or the subject grammar) in a
  way that touches multiple services or the SDKs — see
  [API versioning](../standards/api-versioning.md);
- introduces or moves a **trust boundary** (a new external surface, a new
  credential path, a change to tenant isolation, policy, or the write-path
  dual controls) — see the [threat model](../architecture/threat-model.md) and
  [security self-assessment](../architecture/security-self-assessment.md);
- changes **governance-affecting** behavior (policy semantics, kill-switch
  tiers, eval-gating, approval flows);
- adds a new **core dependency** or a cross-cutting architectural pattern; or
- is large enough that reviewers would reasonably ask "why this shape?" and the
  answer belongs in a durable document.

When in doubt, a one-paragraph issue asking "does this need an RFC?" is cheaper
than guessing.

## When an RFC is *not* required

- Bug fixes, tests, docs, refactors with no contract change.
- A single, self-contained technology or pattern decision — that is an
  [ADR](../adr/README.md), not an RFC. (An RFC often *produces* an ADR; a
  decision that needs no exploratory design can go straight to an ADR PR.)
- Additive, backward-compatible protocol fields covered by the existing
  SemVer + `schema-diff` gate.

## Lifecycle

RFCs live in this directory as `NNNN-short-title.md`, copied from
[`0000-template.md`](0000-template.md).

1. **Draft.** Copy the template to `docs/rfc/0000-my-title.md` (keep `0000`
   until a number is assigned), fill it in, and open a PR. Open a GitHub
   Discussion linked from the PR for wider input.
2. **Discussion.** The RFC is reviewed under the project's **lazy consensus**
   rule ([GOVERNANCE.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/GOVERNANCE.md)): if no maintainer objects within
   **7 days**, it is accepted. Substantive objections are resolved in the
   thread; if consensus fails, the steering group decides.
3. **Numbering.** On acceptance a maintainer assigns the next free number and
   the file is renamed `NNNN-short-title.md`.
4. **Accepted / Rejected.** The outcome is recorded in the RFC's header.
   A rejected RFC is kept for the record (the reasoning is the value).
5. **Landing.** An accepted RFC that changes an architecture decision lands as
   a new or superseding **ADR** in [docs/adr/](../adr/README.md); the
   implementation PRs reference the RFC.

## Roles

Authors write and shepherd the RFC; **maintainers** review and steward
consensus; the **steering group** resolves escalations
([GOVERNANCE.md](https://github.com/jaredgrabill/agentic-control-plane/blob/main/GOVERNANCE.md)). Anyone may comment — user feedback on an
RFC is a first-class contribution.
