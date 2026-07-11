# @acp/mock-tools

Mock MCP tool servers for dev and CI (Phase 2 Item 3): stand-ins for the
enterprise systems the tool agents talk to, serving the
`fixtures/acme-corp` cloud/code datasets over stateless Streamable HTTP
(`enableJsonResponse`, no sessions). `scripts/run-platform.mjs` runs them as
platform-profile node processes — no compose changes.

| Server | Port | Tools |
|---|---|---|
| cloud-estate | 7301 | `inventory_search`, `cost_report` |
| code-forge | 7302 | `repo_dependencies`, `ci_runs` |

Every result rides the `ToolEnvelope` wire shape (`@acp/tool-client`) in
`structuredContent`, mirrored into `content[0].text`, with typed error
codes and document-granularity provenance (the fixture `document` headers,
fixed lineage IDs). `GET /healthz` answers the platform readiness gate.

## Failure directives

Scripted per request via the `x-acp-mock-failure` header or a `?failure=`
query parameter — so tests can exercise typed error paths deterministically:

- `rate_limited[:retry_after_s]` — every tool call returns the
  `rate_limited` envelope (default retry-after 1s).
- `timeout[:ms]` — the server sleeps before handling (default 20000ms,
  beyond the client's 15s default timeout).
- `partial` — successful envelopes are forced partial with a gap note.

## Hermetic use

The server factories are exported so agent eval suites run real MCP
marshalling without sockets — ONE fixture-serving implementation for mocks
and evals alike:

```ts
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCloudServer, loadCloudFixtures } from '@acp/mock-tools';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
void createCloudServer(loadCloudFixtures()).connect(serverTransport);
// hand clientTransport to McpToolClient's transport-factory binding
```

Env: `ACP_MOCK_CLOUD_PORT` (7301), `ACP_MOCK_FORGE_PORT` (7302),
`ACP_MOCK_FIXTURES` (default: the repo's `fixtures/acme-corp`).

No delegated-token verification here — the tool-path PEP is Item 5's Tool
Gateway. Mock output text stays descriptive data, never imperative
model-aimed prose (ASI02); the injection-flavored red-team string lives in
the fixture data itself.
