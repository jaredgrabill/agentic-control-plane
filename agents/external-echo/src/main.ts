/** External-echo proxy agent worker entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildAgent } from './agent.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required to serve the external-echo proxy agent`);
  }
  return value;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // The adapter authenticates to the remote with its OWN credential — never the
  // platform's broker delegated token, which it does not read for anything
  // outbound.
  const agent = buildAgent({
    endpoint: required('ACP_PROXY_ENDPOINT'),
    credential: required('ACP_PROXY_CREDENTIAL'),
  });
  agent.run().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
