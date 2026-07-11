# @acp/protocol

**The single source of truth for cross-language contracts.**

- `schemas/*.schema.json` — JSON Schema 2020-12 sources: agent manifest, task
  contract, audit event.
- `schemas/subjects.json` — the NATS subject hierarchy: templates and closed
  verb vocabularies per entity.
- `src/generated/` (TypeScript) and
  `python/acp-protocol/src/acp_protocol/generated/` (Pydantic v2) — generated
  bindings. **Never edit these; edit the schemas and run `pnpm gen`.**
- `fixtures/` — shared contract fixtures. Both bindings must reach the
  verdicts recorded in `fixtures/expectations.json` for the same bytes; the
  contract tests in each language enforce it.

Hand-maintained parallel types are banned — schema drift between the SDKs is
the platform's version of undefined behavior. CI fails any PR that changes a
schema without regenerating both bindings.

## Making a contract change

1. Edit the schema (and fixtures — add cases that exercise the change).
2. `pnpm gen` (regenerates TS + Python + embedded schema data).
3. `pnpm test` here and `uv run pytest acp-protocol/tests` in `python/`.
4. Commit schemas, fixtures, and both generated outputs in the same PR.
