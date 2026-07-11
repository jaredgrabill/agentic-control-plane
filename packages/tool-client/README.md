# @acp/tool-client

The ToolClient seam between capability handlers and MCP tool servers
(Phase 2 Item 3). Agents call named servers through the `ToolClient`
interface and never touch transport; Item 5's Tool Gateway swaps the
binding under the same interface — agents stay untouched.

## Pieces

- **`ToolClient` / `ToolResponse` / `Provenance`** — the interface handlers
  see. Every response carries Citation-compatible provenance so answers can
  cite tool data directly.
- **`ToolEnvelope`** — the wire shape every ACP tool result rides in
  (MCP `structuredContent`, mirrored into `content[0].text` as JSON), with
  typed error codes: `rate_limited`, `unavailable`, `invalid_input`,
  `not_found`, `upstream_auth`.
- **`McpToolClient`** — ToolClient over MCP Streamable HTTP via
  `@modelcontextprotocol/sdk`. One client + transport per call (pooling is
  the gateway's job). Bindings are `{ url, headers? }` or a
  `{ transport }` factory for hermetic in-memory wiring.
- **`FakeToolClient`** — scripted, recording fake for handler unit tests.
- **`noRetriever(agentId)`** — an explicit "this agent does not retrieve"
  Retriever; passing it makes `serveAgent` skip the NATS + token-exchange
  bootstrap entirely.

## Error mapping (normative, unit-tested row by row)

| Condition | CapabilityError class | Message |
|---|---|---|
| network / connect failure | `retryable` | `tool server ${server} unreachable: ${msg}` |
| MCP request timeout | `retryable` | `tool ${server}.${tool} did not answer within ${timeoutMs}ms` |
| HTTP 401/403 | `policy_denied` | `tool server ${server} refused the call (${status})` |
| envelope `rate_limited` | `retryable` + `details.retry_after_s` | `tool ${server}.${tool} rate limited — retry after ${retry_after_s}s` |
| envelope `unavailable` | `retryable` | pass through |
| envelope `upstream_auth` | `policy_denied` | pass through |
| envelope `invalid_input` | `permanent` (agent bug) | pass through |
| envelope `not_found` | `needs_input` | pass through |
| malformed / unparseable result | `permanent` | `tool ${server}.${tool} returned a malformed result` |

There is no `rate_limited` class in the taxonomy: it maps to `retryable`
with `details.retry_after_s`; Temporal's retry policy (max 3 attempts) is
the v0 backoff. There is no timeout code on the wire — a timeout is the
server not answering, so it surfaces client-side.

## Usage

```ts
import { McpToolClient } from '@acp/tool-client';

const tools = new McpToolClient({
  servers: { 'cloud-estate': { url: 'http://localhost:7301/mcp' } },
});
const { data, provenance } = await tools.call('cloud-estate', 'inventory_search', {
  service: 'payments-api',
  env: 'prod',
});
```
