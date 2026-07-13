/**
 * Hermetic ToolClient: real MCP marshalling over InMemoryTransport against the
 * @acp/mock-tools netsec server — the ONE fixture-serving implementation
 * shared by the dev mocks, the eval suite, and the CI report emitter. No
 * sockets, no duplicated fixture logic.
 *
 * No store: the netsec server is pure reads over injected fixtures (forge
 * pattern), so a fresh McpServer per call closes over the same immutable
 * snapshot — there is no write state to share.
 */

import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNetsecServer, loadNetsecFixtures } from '@acp/mock-tools';
import { McpToolClient, type ToolClient } from '@acp/tool-client';
import { NETSEC } from './tools.js';

/** Repo-root fixtures/acme-corp, resolved from this module. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/acme-corp', import.meta.url));

export function fixtureToolClient(fixturesDir: string = FIXTURES_DIR): ToolClient {
  const fixtures = loadNetsecFixtures(fixturesDir);
  return new McpToolClient({
    servers: {
      [NETSEC]: {
        transport: () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          void createNetsecServer(fixtures).connect(serverTransport);
          return clientTransport;
        },
      },
    },
  });
}
