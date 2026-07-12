/**
 * Hermetic ToolClient: real MCP marshalling over InMemoryTransport against
 * the @acp/mock-tools cloud-estate server — the ONE fixture-serving
 * implementation shared by the dev mocks, the eval suite, and the CI report
 * emitter. No sockets, no duplicated fixture logic.
 */

import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CloudStore, createCloudServer, loadCloudFixtures } from '@acp/mock-tools';
import { McpToolClient, type ToolClient } from '@acp/tool-client';
import { CLOUD_ESTATE } from './tools.js';

/** Repo-root fixtures/acme-corp, resolved from this module. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/acme-corp', import.meta.url));

export function fixtureToolClient(fixturesDir: string = FIXTURES_DIR): ToolClient {
  const fixtures = loadCloudFixtures(fixturesDir);
  // ONE shared CloudStore per ToolClient closure: tag writes (apply/restore)
  // must survive the fresh-McpServer-per-call transport so an eval that applies
  // a tag then restores it sees its own writes (read-your-writes).
  const store = new CloudStore(fixtures);
  return new McpToolClient({
    servers: {
      [CLOUD_ESTATE]: {
        transport: () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          void createCloudServer(store).connect(serverTransport);
          return clientTransport;
        },
      },
    },
  });
}
