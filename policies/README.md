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

The engine is **default deny**: no permit → deny. Cedar itself stays
two-verdict; a `@decision("require-approval")` annotation on a **permit**
lifts the allow it determines into a three-way `require-approval` (Phase 3
approval machinery). The lift is restrictive: if any policy determining an
allow is annotated, the decision is require-approval — a later broad plain
permit cannot bypass a gate. `@decision` on a forbid, or any value other
than `require-approval`, is a bundle load error.

### Pair-policy convention (R2 tool permits, item 3)

An R2 tool capability is expressed as a PAIR: a plain permit that requires
the approved grounds (`context.approval.granted == true &&
context.approval.capability == "<capability>"`) plus an annotated
`gate-*` permit whose `when` excludes the already-approved case. Because
the lift is restrictive, a sloppy gate can only over-gate (block), never
silently bypass — the fail-safe direction.

## Authorization model (v0)

| Element | Types | Notes |
| --- | --- | --- |
| principal | `User`, `Service`, `Agent` | attrs carry `tenant` |
| action | `Action::"delegate"`, `Action::"<capability>"`, `Action::"tool:<server>:<tool>"` | capability invocations use the capability name; tool calls (decided at the Tool Gateway PEP) name the exact tool on the exact server |
| resource | `Agent`, `Corpus`, `Service` | attrs carry `tenant` (`Service` resources carry none — tenancy rides `context.tenant`) |
| context | `tenant`, `scopes`, `risk`, … | scopes come from the *delegated* token |
