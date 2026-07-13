/**
 * The external-echo proxy agent: a manifest-bound @acp/agent-sdk Agent whose
 * capabilities are served by the A2A proxy adapter. It uses noRetriever (it
 * grounds on the remote reply, not the knowledge store), so the worker
 * bootstrap skips NATS + token-exchange wiring entirely — the adapter holds no
 * bus identity and binds no tools.
 */

import { fileURLToPath } from 'node:url';
import { Agent } from '@acp/agent-sdk';
import { A2AClient, registerProxyCapabilities } from '@acp/a2a-proxy';
import { noRetriever } from '@acp/tool-client';

/** The name any remote-supplied provenance is tagged with (external:<name>). */
export const REMOTE_NAME = 'external-echo-remote';

export interface ProxyAgentOptions {
  /** The remote A2A endpoint URL (ACP_PROXY_ENDPOINT). */
  endpoint: string;
  /** The adapter's OWN credential for the remote (ACP_PROXY_CREDENTIAL). */
  credential: string;
  /** Test seam for the remote transport. */
  fetchImpl?: typeof fetch;
}

export function buildAgent(opts: ProxyAgentOptions): Agent {
  const agent = Agent.fromManifest(fileURLToPath(new URL('../manifest.yaml', import.meta.url)), {
    retriever: noRetriever('external-echo'),
  });
  const client = new A2AClient({
    endpoint: opts.endpoint,
    credential: opts.credential,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });
  registerProxyCapabilities(agent, { client, remoteName: REMOTE_NAME });
  return agent;
}
