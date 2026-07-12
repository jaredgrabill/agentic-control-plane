/** Tool bindings: the cloud-estate MCP server, addressed by name. */

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

export const CLOUD_ESTATE = 'cloud-estate';

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
          clientId: process.env.ACP_AGENT_CLIENT_ID ?? 'agent-cloud-agent',
          clientSecret,
        })
      : undefined;
  return new McpToolClient({
    servers: {
      [CLOUD_ESTATE]: {
        url:
          process.env.ACP_TOOL_SERVER_CLOUD_ESTATE_URL ?? 'http://localhost:7106/mcp/cloud-estate',
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

/**
 * The idempotency key for a write is the step id: plan-minted, stable across
 * activity retries — exactly the duplicate-delivery boundary (design §D5). A
 * multi-write step suffixes it deterministically (e.g. `:restore:apply`). A
 * missing step id is a caller bug, not something to paper over with a random
 * key (which would defeat de-duplication).
 */
export function idempotencyKey(ctx: Pick<CapabilityContext, 'stepId'>, suffix = ''): string {
  const key = ctx.stepId;
  if (typeof key !== 'string' || key.length < 8) {
    throw new CapabilityError(
      ErrorClass.Permanent,
      'a write step has no usable step id for the idempotency key — cannot de-duplicate safely',
    );
  }
  return `${key}${suffix}`;
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
