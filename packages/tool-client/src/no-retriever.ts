/**
 * noRetriever: an explicit "this agent does not retrieve" Retriever.
 *
 * Passing it to Agent.fromManifest makes serveAgent skip the NATS +
 * TokenExchanger bootstrap entirely, so tool-only agents need no NATS
 * credentials and no token-service client entry.
 */

import type { Retriever } from '@acp/agent-sdk';

export function noRetriever(agentId: string): Retriever {
  return {
    search: () =>
      Promise.reject(new Error(`agent ${agentId} does not use the knowledge retriever`)),
  };
}
