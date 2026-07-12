/** cloud-estate mock server entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { serveMcp } from '../shared/http.js';
import { loadCloudFixtures } from './fixtures.js';
import { createCloudServer } from './server.js';
import { CloudStore } from './store.js';

const port = Number(process.env.ACP_MOCK_CLOUD_PORT ?? 7301);
const fixtures = loadCloudFixtures();
// ONE store per process: the fresh-McpServer-per-POST door closes over it, so
// an applied tag is visible (and removable) on the next request.
const store = new CloudStore(fixtures);
serveMcp({ port, createServer: (failure) => createCloudServer(store, { failure }) });
console.log(`cloud-estate mock MCP server listening on :${port}/mcp`);
