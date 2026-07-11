/** cloud-estate mock server entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { serveMcp } from '../shared/http.js';
import { loadCloudFixtures } from './fixtures.js';
import { createCloudServer } from './server.js';

const port = Number(process.env.ACP_MOCK_CLOUD_PORT ?? 7301);
const fixtures = loadCloudFixtures();
serveMcp({ port, createServer: (failure) => createCloudServer(fixtures, { failure }) });
console.log(`cloud-estate mock MCP server listening on :${port}/mcp`);
