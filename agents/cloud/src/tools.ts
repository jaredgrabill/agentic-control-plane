/** Tool bindings: the cloud-estate MCP server, addressed by name. */

import process from 'node:process';
import { CapabilityError, ErrorClass, type CapabilityContext } from '@acp/agent-sdk';
import {
  McpToolClient,
  type CallOptions,
  type Provenance,
  type ToolClient,
  type ToolResponse,
} from '@acp/tool-client';

export const CLOUD_ESTATE = 'cloud-estate';

/** Item 5: tool calls traverse the Tool Gateway PEP; only the URL changed. */
export function createToolClient(): ToolClient {
  return new McpToolClient({
    servers: {
      [CLOUD_ESTATE]: {
        url:
          process.env.ACP_TOOL_SERVER_CLOUD_ESTATE_URL ?? 'http://localhost:7106/mcp/cloud-estate',
      },
    },
  });
}

/**
 * Every tool call carries the step's delegated identity and correlation
 * ids — the gateway authenticates the token and joins the call to the
 * task in the audit trail.
 */
export function callOptions(
  ctx: Pick<CapabilityContext, 'delegatedToken' | 'taskId' | 'stepId'>,
): CallOptions {
  return { delegatedToken: ctx.delegatedToken, taskId: ctx.taskId, stepId: ctx.stepId };
}

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
