/**
 * ToolEnvelope helpers now live in @acp/tool-client (src/envelope.ts) —
 * one implementation shared by the mocks, the client, and the Tool
 * Gateway. This module re-exports them so the mock servers' imports and
 * the package's public surface stay put.
 */

export { fail, ok, toCallToolResult } from '@acp/tool-client';
