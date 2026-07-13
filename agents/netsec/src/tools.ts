/**
 * Tool bindings: the netsec MCP server, addressed by name. All four netsec
 * tools are reads — this module deliberately has NO idempotency-key helper
 * (there is no write to de-duplicate) and no capability here ever passes one.
 */

import process from 'node:process';
import { CapabilityError, ErrorClass, type CapabilityContext } from '@acp/agent-sdk';
import {
  McpToolClient,
  toolTokenProvider,
  type CallOptions,
  type Provenance,
  type ToolClient,
  type ToolResponse,
} from '@acp/tool-client';

export const NETSEC = 'netsec';

/**
 * Tool calls traverse the Tool Gateway PEP. When the agent's own client
 * secret is configured, each call exchanges the step's delegated token for an
 * `acp:tools` token (the gateway's only accepted audience). Without a secret
 * (unit tests) the delegated token is sent verbatim.
 */
export function createToolClient(): ToolClient {
  const clientSecret = process.env.ACP_AGENT_CLIENT_SECRET;
  const tokenProvider =
    clientSecret !== undefined
      ? toolTokenProvider({
          tokenUrl: process.env.ACP_TOKEN_URL ?? 'http://localhost:7101',
          clientId: process.env.ACP_AGENT_CLIENT_ID ?? 'agent-netsec-agent',
          clientSecret,
        })
      : undefined;
  return new McpToolClient({
    servers: {
      [NETSEC]: {
        url: process.env.ACP_TOOL_SERVER_NETSEC_URL ?? 'http://localhost:7106/mcp/netsec',
      },
    },
    ...(tokenProvider !== undefined ? { tokenProvider } : {}),
  });
}

/**
 * Every tool call carries the step's delegated identity and correlation ids —
 * the gateway authenticates the token and joins the call to the task in the
 * audit trail.
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
