/**
 * Hermetic ToolClient: real MCP marshalling over InMemoryTransport against
 * the @acp/mock-tools code-forge server — the ONE fixture-serving
 * implementation shared by the dev mocks, the eval suite, and the CI report
 * emitter. No sockets, no duplicated fixture logic.
 */

import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createForgeServer, loadForgeFixtures } from '@acp/mock-tools';
import { McpToolClient, type ToolClient } from '@acp/tool-client';
import { CODE_FORGE } from './tools.js';

/** Repo-root fixtures/acme-corp, resolved from this module. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/acme-corp', import.meta.url));

export function fixtureToolClient(fixturesDir: string = FIXTURES_DIR): ToolClient {
  const fixtures = loadForgeFixtures(fixturesDir);
  return new McpToolClient({
    servers: {
      [CODE_FORGE]: {
        transport: () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          void createForgeServer(fixtures).connect(serverTransport);
          return clientTransport;
        },
      },
    },
  });
}
