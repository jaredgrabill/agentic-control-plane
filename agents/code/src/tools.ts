/** Tool bindings: the code-forge MCP server, addressed by name. */

import process from 'node:process';
import { CapabilityError, ErrorClass } from '@acp/agent-sdk';
import {
  McpToolClient,
  type Provenance,
  type ToolClient,
  type ToolResponse,
} from '@acp/tool-client';

export const CODE_FORGE = 'code-forge';

/** Direct binding to the mock in Item 3; the Tool Gateway swaps the URL in Item 5. */
export function createToolClient(): ToolClient {
  return new McpToolClient({
    servers: {
      [CODE_FORGE]: {
        url: process.env.ACP_TOOL_SERVER_CODE_FORGE_URL ?? 'http://localhost:7302/mcp',
      },
    },
  });
}

/** Shared repo shape guard: org/name, lowercase, no shell noise. */
export const REPO_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;

/** The document header every answer cites; a provenance-free tool result is a contract bug. */
export function primaryProvenance(response: ToolResponse): Provenance {
  const first = response.provenance[0];
  if (first === undefined) {
    throw new CapabilityError(
      ErrorClass.Permanent,
      'tool response carried no provenance — nothing to cite',
    );
  }
  return first;
}
