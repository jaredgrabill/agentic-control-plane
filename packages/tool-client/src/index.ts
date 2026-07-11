/**
 * @acp/tool-client — the ToolClient seam between capability handlers and
 * MCP tool servers: typed envelopes, normative error mapping, and fakes.
 */

export { FakeToolClient, type FakeToolHandler } from './fake.js';
export { McpToolClient, type ServerBinding } from './mcp-client.js';
export { noRetriever } from './no-retriever.js';
export type { Provenance, ToolClient, ToolEnvelope, ToolResponse } from './types.js';
