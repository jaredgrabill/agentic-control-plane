/** Network security agent worker entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Agent } from '@acp/agent-sdk';
import { noRetriever } from '@acp/tool-client';
import { registerCapabilities } from './capabilities/index.js';
import { createToolClient } from './tools.js';

export const agent = Agent.fromManifest(
  fileURLToPath(new URL('../manifest.yaml', import.meta.url)),
  // Explicitly no retriever: this agent grounds on tool data, so the worker
  // bootstrap skips NATS + token-exchange wiring entirely.
  { retriever: noRetriever('netsec-agent') },
);
registerCapabilities(agent, { tools: createToolClient() });

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  agent.run().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
