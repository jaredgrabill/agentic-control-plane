# Standard: Tool Integration

How enterprise systems become agent-callable tools. The unit is the
**MCP tool server**; the discipline is that tools are products with
contracts, owners, and reviews — not scripts.

## Protocol

- Tool servers implement **MCP over Streamable HTTP**, written stateless
  (aligned with the MCP 2026-07-28 stateless core) so replicas scale behind
  plain load balancing.
- Auth per MCP spec: OAuth 2.1 resource-server pattern; inside the platform
  the tool gateway presents the delegated platform token
  ([security.md](../architecture/security.md)).
- Tool servers register in the platform registry with a `server.json`-style
  record: tools, schemas, owning team, wrapped system of record, data
  classification, rate limits.

## Deployment Topology

Agents never reach tool servers directly — calls traverse the **tool
gateway** (Gateway role), which enforces:

1. policy decision (Cedar) per call,
2. credential brokering (system-of-record credentials injected server-side;
   agents hold none),
3. schema validation both directions,
4. rate limiting per (tool, tenant),
5. audit + telemetry emission.

The gateway supports **progressive tool disclosure**: agents get search/
describe meta-tools plus their manifest-bound tools, not a firehose of every
schema on the platform — token cost and attack surface both drop.

## Tool Design Rules

- **One tool = one action** with typed input/output. `run_command(cmd)` is
  banned; `restart_service(service_id)` is a tool. Free-form escape hatches
  defeat policy (you cannot write a Cedar rule about the contents of a shell
  string).
- Tools **MUST** declare a risk class like capabilities do (R0–R3); the
  gateway refuses R2 tool calls from R0/R1 capability contexts — risk can't
  be laundered through a lower-risk capability.
- Read tools **MUST** be side-effect free and idempotent; write tools
  **MUST** accept an idempotency key and **SHOULD** offer `dry_run`.
- Outputs are data, not instructions: tool servers **MUST NOT** embed
  imperative text intended for the model ("now call X") — such patterns are
  rejected in review and screened at the gateway (injection surface, ASI02).
- Errors are structured and typed (same taxonomy as capabilities), including
  `rate_limited` with retry-after — the orchestrator's backoff depends on it.
- Pagination/truncation is explicit: tools return bounded results with
  continuation tokens; "return everything" tools fail review.

## Sandboxed Execution Tools

Tools that execute agent-influenced code (interpreters, shells, compilers,
IaC applies) get a stricter deployment shape than ordinary API wrappers:

- The tool server runs **inside the sandbox** (Firecracker/Kata microVM or
  gVisor — plain containers don't qualify, per
  [security.md](../architecture/security.md)).
- **Outbound-only connectivity:** the sandboxed server makes a single
  outbound NATS connection and serves its dedicated subjects; it listens on
  **no inbound sockets**, and its egress allowlist is the NATS endpoint and
  nothing else. An exploited execution tool has no corporate network to
  scan and no way to be reached — the bus subject is its entire world.
- Sandboxes are **per-task and disposable**: created for the step, destroyed
  after, never reused across tenants or tasks.
- Results return as data through the normal gateway path (schema-validated,
  policy-logged); artifacts go to object storage by reference.

## Wrapping Legacy Systems

- Wrap the **system of record's API**, never its database.
- The tool contract models the *domain action*, not the vendor API shape —
  `change.create_draft` not `POST /api/now/table/change_request` — so
  swapping ITSM vendors is a tool-server change, invisible to agents.
- Enterprise API quirks (auth dances, pagination, eventual consistency)
  are absorbed inside the tool server; agents see clean semantics.
- Each tool server has a **contract test suite** run against a sandbox/mock
  of the wrapped system in CI, and (where feasible) nightly against a
  non-prod instance — tool contract drift is a leading cause of production
  agent failure, so it gets caught by tests, not by agents.

## Versioning

- Tool contracts are semver'd; breaking schema changes require a new major
  version served in parallel through a deprecation window (registry tracks
  which agent versions bind which tool versions — deprecation is a
  queryable blast-radius question, not an email thread).
- Contract changes trigger eval runs for **every agent bound to the tool**
  (the registry knows exactly which) before the new version is promoted.

## Testing Tools

Per [testing.md](testing.md):

- Unit: schema round-trips, error taxonomy mapping, idempotency.
- Contract: recorded-interaction tests against the wrapped system's sandbox.
- Security: authz bypass attempts, injection payloads in every string field,
  oversized inputs — in CI, not just annual pentests.
- Load: rate-limit behavior verified (the gateway trusts the declared
  limits; wrong declarations melt fragile enterprise systems).
