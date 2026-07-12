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

Realized R2 tool pairs (item 3): `permit`/`gate-tool-itsm-change-submit`,
`…-itsm-change-withdraw`, `…-cloud-estate-tag-apply`,
`…-cloud-estate-tag-remove`. The tool gateway derives `context.approval`,
`context.compensation`, and `context.capability` from the VERIFIED token
claims (never a header) and binds approval to the exact step before the
decision. A withdraw/restore permit ALSO accepts a compensation grounds
branch (`context.compensation.active == true &&
context.compensation.original_capability == "<original>"`) — a compensator
is pre-authorized by the original write's approval and must not re-gate.

**`has`-guard discipline:** every access past a variant field is guarded
(`context.approval has capability`, `context.compensation has
original_capability`) and ordered AFTER the boolean that selects the
variant (`granted == true && … has capability && …`), so Cedar
short-circuits before touching an absent attribute — a gate permit must
never evaluation-error (that would fail the decision closed but silently).
R0/R1 tool permits (`allow-tool-itsm-change-get`,
`allow-tool-itsm-calendar-conflicts`, `allow-tool-itsm-change-draft`) are
plain permits with no approval binding; the structural risk-class check at
the gateway is the defense-in-depth backstop that also refuses R2 tools
called from an R0/R1 or absent capability context.

### Compensation carve-out (item 2)

When a task fails, is cancelled, or is caught by a kill switch, the
orchestrator unwinds its saga: it re-dispatches each completed R2+ write's
declared compensator through the SAME delegation PEP, tagged with a
`compensation` context flag (`context.compensation.active == true`).
`permit-compensation.cedar` is a **plain** permit (no `@decision`) that allows
these delegations outright for R1/R2 in the same tenant — a compensator is
**pre-authorized by the write's original approval** and must never re-suspend
on a human gate (re-gating would strand a live write whenever a task failed
unattended). Correspondingly, `gate-r2-delegation.cedar` carries
`!(context has compensation)` so the restrictive lift never fires on an
unwind. Item 3's R2 tool policies MUST honor `context.compensation` the same
way (a compensator's tool call is not itself re-gated). The `compensation`
flag can only originate in the TaskWorkflow unwind loop — agents never
construct a `StepDispatch` — and is carried defense-in-depth by a signed
`compensation` token claim (broker-minted only).

## Authorization model (v0)

| Element | Types | Notes |
| --- | --- | --- |
| principal | `User`, `Service`, `Agent` | attrs carry `tenant` |
| action | `Action::"delegate"`, `Action::"<capability>"`, `Action::"tool:<server>:<tool>"` | capability invocations use the capability name; tool calls (decided at the Tool Gateway PEP) name the exact tool on the exact server |
| resource | `Agent`, `Corpus`, `Service` | attrs carry `tenant` (`Service` resources carry none — tenancy rides `context.tenant`) |
| context | `tenant`, `scopes`, `risk`, … | scopes come from the *delegated* token |
