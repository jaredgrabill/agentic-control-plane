/** netsec mock server entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { serveMcp } from '../shared/http.js';
import { loadNetsecFixtures } from './fixtures.js';
import { createNetsecServer } from './server.js';

const port = Number(process.env.ACP_MOCK_NETSEC_PORT ?? 7304);
const fixtures = loadNetsecFixtures();
serveMcp({ port, createServer: (failure) => createNetsecServer(fixtures, { failure }) });
console.log(`netsec mock MCP server listening on :${port}/mcp`);
