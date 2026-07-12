# Policy Bundles

Cedar policies are **the most privileged change type in the platform**
(governance-and-policy.md): versioned here, reviewed like code (2
approvals), tested like code. The Policy Service loads this directory as
its active bundle; the bundle version (VERSION + content hash) is stamped
into every decision and audit record.

Layout:

- `*.cedar` — one file per policy, named after its `@id` annotation.
- `tests/cases.json` — the golden allow/deny suite. CI fails when a policy
  exists that no allow case exercises (untested territory must not ship)
  or when any case's verdict flips unexpectedly.
- `VERSION` — human-readable bundle version prefix.

The engine is **default deny**: no permit → deny. v0 issues allow/deny
only; `require-approval` decisions arrive with the approval machinery in
Phase 3.

## Authorization model (v0)

| Element | Types | Notes |
| --- | --- | --- |
| principal | `User`, `Service`, `Agent` | attrs carry `tenant` |
| action | `Action::"delegate"`, `Action::"<capability>"` | capability invocations use the capability name |
| resource | `Agent`, `Corpus` | attrs carry `tenant` |
| context | `tenant`, `scopes`, `risk`, … | scopes come from the *delegated* token |
