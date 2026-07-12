# Tool Gateway

The MCP-terminating proxy between agents (and IDE-shaped users) and tool
servers: an MCP **server** to callers at `POST /mcp/{serverId}`, an MCP
**client** to upstreams. The gateway replaces the URL, not the interface —
agents keep calling `tools.call('cloud-estate', 'inventory_search', args)`
and only the endpoint env var changes to
`http://localhost:7106/mcp/cloud-estate`.

Per call, in order: authN (delegated JWT) → kill switch → governed-tool
lookup → Cedar → rate limit → input schema validation → credential
brokering → forward → response validation → `tool.called` audit + OTel
span. Every refusal after authN is a typed ToolEnvelope error inside an
MCP result, so the `@acp/tool-client` error mapping fires unchanged;
authN failures are HTTP 401.

## Which tokens the gateway accepts

`verifyWithAudience` accepts exactly one audience: `aud === 'acp:tools'`
(Phase 3 item 0c — the audience-family sprawl of v1 is closed, debt #2).
Multi-audience tokens are refused by `verifyWithAudience` regardless.

Agents no longer present their step's delegated token (audience
`acp:agent:{id}`) here. Each agent exchanges that token — using its **own**
client secret, a second independent credential — for one bound to
`acp:tools` (RFC 8693, same-actor narrowing; see
`packages/tool-client` `toolTokenProvider`). Two consequences:

- A stolen delegated step token replayed at the gateway opens **nothing**:
  its audience is not accepted, and converting it needs the agent secret.
- **Orchestrator-chain check** (`resolveCaller`): an `acp:tools` token whose
  acting principal is an Agent (`act.sub` starts `agent:`) must carry a
  delegation chain whose innermost actor is `svc:orchestrator` — the sole
  broker (ADR-0007). This refuses an agent-secret + stolen-subject-token
  fabrication that names an agent actor with no broker hop underneath.
  User and Service principals are exempt (IDE users mint `acp:tools`
  directly and have no chain by design; Cedar gates them). This is a
  structural gate — Cedar still makes the real authorization decision on
  top of it, so a platform-role client that can fabricate a full chain is
  caught by policy (and is a trusted-infra, audited concern), not here.

## Credential brokering

Upstream credentials are never agent-visible and the caller's
`Authorization` header is never forwarded upstream (structural: upstream
headers are built solely from the broker result plus `x-acp-*`
correlation headers — see `src/upstream.ts`).

- `static-headers` (cloud-estate, code-forge): configured headers,
  env-expanded at startup (`${VAR:-default}`) — the dev stand-in for
  vaulted API keys.
- `token-exchange` (knowledge): per-call RFC 8693 exchange as
  `svc-tool-gateway` — audience rebound to `acp:knowledge`, scopes
  intersected down to `knowledge:search:read`, **actor preserved** so the
  knowledge service's own PEP evaluates the true principal. Double PEP on
  retrieval is deliberate defense-in-depth.

## v1 limitations (deliberate)

- **Static registry**: `deploy/dev/tool-servers.json` is the tool-server
  catalog; the tools map is both allowlist and scope mapping. A tool not
  in it cannot be called (no `run_command` by omission). Registry-backed
  tool cards come later.
- **In-memory rate limiting**: token buckets per (server, tool, tenant),
  per-instance, reset on restart; distributed limiting is Phase 3. The
  limiter runs *after* Cedar so denials never consume quota.
- **Per-call exchange**, no caching: +2 hops on knowledge calls.
- **No sessions/SSE**: stateless per-request MCP, JSON responses;
  GET/DELETE answer 405.
- **Audit is R0 alarm-and-continue**; R1+ risk classes fail closed at
  this PEP when they arrive (Phase 3, with require-approval).
- **Disclosure v1** = per-server routing + scope-filtered `tools/list`;
  `tools/call` enforcement is the load-bearing control.

## Environment

| Variable | Default |
| --- | --- |
| `ACP_TOOL_GATEWAY_PORT` | `7106` |
| `ACP_TOOL_SERVERS` | `deploy/dev/tool-servers.json` |
| `ACP_JWKS_URL` / `ACP_TOKEN_ISSUER` / `ACP_POLICY_URL` / `ACP_TOKEN_URL` | dev-stack defaults |
| `ACP_TOOL_GATEWAY_CLIENT_ID` / `_SECRET` | `svc-tool-gateway` / `tool-gateway-dev-secret` |
| `ACP_NATS_SERVICE_USER` / `_PASSWORD` | `tool-gateway` / `tool-gateway-dev-password` |
| `ACP_OTLP_ENDPOINT` | dev collector |
| `ACP_TOOL_CRED_CLOUD_ESTATE` / `_CODE_FORGE` | dev broker strings via `${VAR:-…}` |
