/** code-forge mock server entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { serveMcp } from '../shared/http.js';
import { loadForgeFixtures } from './fixtures.js';
import { createForgeServer } from './server.js';

const port = Number(process.env.ACP_MOCK_FORGE_PORT ?? 7302);
const fixtures = loadForgeFixtures();
serveMcp({ port, createServer: (failure) => createForgeServer(fixtures, { failure }) });
console.log(`code-forge mock MCP server listening on :${port}/mcp`);
