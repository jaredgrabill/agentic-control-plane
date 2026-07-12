/** Tool bindings: the code-forge MCP server, addressed by name. */

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

export const CODE_FORGE = 'code-forge';

/**
 * Item 5: tool calls traverse the Tool Gateway PEP. Item 0c: when the
 * agent's own client secret is configured, each call exchanges the step's
 * delegated token for an `acp:tools` token (the gateway's only accepted
 * audience after the flip). Without a secret (unit tests) the delegated
 * token is sent verbatim.
 */
export function createToolClient(): ToolClient {
  const clientSecret = process.env.ACP_AGENT_CLIENT_SECRET;
  const tokenProvider =
    clientSecret !== undefined
      ? toolTokenProvider({
          tokenUrl: process.env.ACP_TOKEN_URL ?? 'http://localhost:7101',
          clientId: process.env.ACP_AGENT_CLIENT_ID ?? 'agent-code-agent',
          clientSecret,
        })
      : undefined;
  return new McpToolClient({
    servers: {
      [CODE_FORGE]: {
        url: process.env.ACP_TOOL_SERVER_CODE_FORGE_URL ?? 'http://localhost:7106/mcp/code-forge',
      },
    },
    ...(tokenProvider !== undefined ? { tokenProvider } : {}),
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
