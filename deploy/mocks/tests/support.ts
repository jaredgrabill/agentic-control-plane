import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/acme-corp', import.meta.url));

/** One raw MCP round trip against a fresh in-memory pair. */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mock-tools-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}
