# acp-protocol

Python bindings for the ACP protocol contracts.

Everything importable here derives from `packages/protocol/schemas` — the
single source of truth for cross-language contracts. The Pydantic models in
`acp_protocol.generated` and the schema documents shipped as package data are
**generated artifacts**: edit the schemas and run `pnpm gen` (from
`packages/protocol`), never these files. CI rejects contract changes that
don't regenerate both language bindings in the same PR.
