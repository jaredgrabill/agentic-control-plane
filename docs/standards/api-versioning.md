# API Versioning & Stability

This is the contract behind the "1.0" claim: what the platform promises not to
break, how those promises are versioned, and the CI gates that enforce them
mechanically so a promise can't be broken by accident.

The rule in one line: **the public surface follows [Semantic Versioning](https://semver.org).
Additive changes are minor; anything that forces a consumer to change is major.**

## The Public API Surface

Three things are frozen at 1.0. Everything else is an implementation detail and
may change in any release.

### 1. The wire contract (the SemVer core)

The cross-language protocol in `packages/protocol/schemas/`:

- The JSON Schemas: `agent-card`, `agent-manifest`, `task-contract`,
  `audit-event`, `eval-report`, `tool-server`, and `a2a-agent-card`.
- The NATS subject grammar: `subjects.json`.

This is the real interoperability surface. A change here can force **any**
consumer — the TypeScript SDK, the Python SDK, or an external A2A client
reading a card — to change. It is the most tightly gated part of the platform
(see [Enforcement](#enforcement)). Its frozen state is snapshotted in
`packages/protocol/schema-baseline.json`, which the schema-diff gate compares
every PR against.

### 2. The TypeScript SDK packages

- `@acp/protocol` — generated bindings, validators, subject builders.
- `@acp/agent-sdk` — `Agent`, capability handlers, model/retrieval access,
  telemetry, the eval harness.
- `@acp/tool-client` — the `ToolClient` seam to MCP tool servers.
- `@acp/llm-client` — LLM Gateway wire types and `GatewayClient`.
- `@acp/create-agent` — the scaffolder CLI.

The exported declaration surface of each library is captured in a committed
report at `packages/<pkg>/etc/<pkg>.api.md` and gated in CI.

### 3. The Python SDK packages

- `acp-protocol` — generated pydantic models, validators, subject builders.
- `acp-agent-sdk` — the Python twin of `@acp/agent-sdk`.
- `acp-create-agent` — the Python scaffolder CLI.

The TypeScript and Python SDKs are held to case-by-case behavioral equality by
the `parity` CI gate — they are two renderings of one contract, not two
contracts.

### Explicitly NOT frozen (0.x, internal)

These are support libraries and may break in any minor. Do not depend on them
across a version boundary:

`@acp/service-kit`, `@acp/online-eval`, `@acp/judge`, `@acp/embedding`,
`@acp/cost-meter`, and the `@acp/*` control-plane service apps.

**Experimental capabilities** — any capability flagged `experimental: true` in
its manifest — carry **no compatibility guarantee**. They route shadow-only,
relax eval-baseline requirements, and may change or disappear in a minor. This
is the intended escape hatch for iterating in production before freezing a
contract.

## What Counts as Breaking

For the wire schemas and subject grammar:

| Change | Classification |
|---|---|
| Add an optional property | **minor** (additive) |
| Add a new schema, `$def`, or subject entity | **minor** |
| Add a value to an enum | **minor** (append-only — see below) |
| Add a value to a subject verb list | **minor** |
| Loosen a constraint (drop/relax `minLength`, `pattern`, `maximum`, …) | **minor** |
| Relax a required field to optional | **minor** |
| Remove or rename a property, `$def`, schema, or subject | **major** |
| Add a new **required** property | **major** (existing producers omit it) |
| Remove an enum value or subject verb | **major** |
| Change a `type`, `const`, `format`, `$ref`, or `pattern` | **major** |
| Tighten a numeric/length/item bound | **major** |
| Close an object (`additionalProperties: true → false`) | **major** |

For the SDK packages, the usual SemVer rules on the exported TypeScript/Python
surface apply: adding an export or an optional parameter is minor; removing or
retyping an export, or making a parameter required, is major.

### The audit-event enum is append-only — forever

The `event_type` enum in `audit-event.schema.json` is **append-only and may
never be reordered or have a value removed**, independent of the SemVer major
cadence. Two things depend on it:

1. **The audit hash chain.** Records are hash-chained; historical records
   carry event types that were valid when written. Removing or renumbering a
   value breaks decoding of the existing chain and therefore breaks
   [chain verification](../runbooks/dr-postgres-backup-restore.md).
2. **Replay.** Auditors replay historical events; an unknown or shifted type
   silently corrupts that view.

Adding a new event type is a normal minor change. This rule is also load-bearing
for [rolling upgrades](../runbooks/upgrade-rolling.md), where old and new
service versions read the same audit stream concurrently. The schema-diff gate
treats a removed audit enum value as a breaking governance violation.

## Deprecation Policy

Removing anything from the frozen surface is a two-release dance, never a
surprise:

1. **Mark** the field/export/capability deprecated (a schema `description`
   note, a JSDoc/docstring `@deprecated`, or a runtime warning) in a minor.
2. **Warn** for at least one full minor release — the runtime emits a
   deprecation warning when the deprecated path is used.
3. **Remove** only in the next major, with a migration note in the changelog
   and, for architecture-level changes, a superseding
   [ADR](../adr/README.md).

## Enforcement

Promises that aren't enforced are wishes. Five CI gates make the surface above
mechanical (all in the `ci` workflow):

- **`contracts`** — regenerates the bindings from the schemas and fails if the
  committed TS/Python outputs drift. The schemas are the single source of truth.
- **`parity`** — runs the same golden fixtures through both SDKs and fails if
  their verdicts disagree case by case.
- **`api-freeze` → schema-diff** — `scripts/schema-diff.mjs` compares the live
  schema surface against the committed frozen baseline
  (`packages/protocol/schema-baseline.json`), classifies every difference, and
  **fails the PR on a breaking change unless the PR carries the `breaking`
  label** (a deliberate major bump). A no-change PR is byte-identical to the
  baseline and passes. The gate is itself self-tested against a deliberately
  breaking fixture, so a gate that stops gating fails the build.
- **`api-freeze` → api-report** — `pnpm api:check` extracts the exported
  declaration surface from each SDK's built `.d.ts` and fails if the committed
  `etc/*.api.md` report is stale. An API change can't land undocumented.
- **`release-please`** — Conventional Commits drive per-package version bumps,
  changelogs, and tags. Each public package is an independently-versioned
  component; the wire pair (`protocol` + `acp-protocol`) is version-linked
  because they are one contract.

### Making a breaking change (a major bump)

1. Change the schema (and run `pnpm gen` to regenerate both bindings).
2. Add the `breaking` label to the PR — this sets `ACP_ALLOW_BREAKING=1` for
   the schema-diff gate.
3. Regenerate the frozen baseline: `pnpm schema:baseline` (writes
   `packages/protocol/schema-baseline.json`), and commit it.
4. Update `etc/*.api.md` if the SDK surface moved: `pnpm api:report`.
5. The Conventional Commit must express the major intent (`feat!:` or a
   `BREAKING CHANGE:` footer) so release-please bumps the major.

The frozen baseline should also be regenerated at each release so the gate
measures "compatible since the last release." A no-op PR always passes because
the baseline tracks what shipped.

## Cutting 1.0

At 1.0 the versions above move from `0.1.0` to `1.0.0` together. If the
release-please automation is available, a `Release-As: 1.0.0` footer on a
commit drives it. If it is blocked (see the
[rolling-upgrade runbook's manual-tag fallback](../runbooks/upgrade-rolling.md)),
1.0 is cut as a manually-signed annotated tag. Either way, this document — and
the gates that enforce it — is the definition of what 1.0 promises.
