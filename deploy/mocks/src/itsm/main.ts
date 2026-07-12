/** itsm mock server entrypoint (dev platform profile). */

import console from 'node:console';
import process from 'node:process';
import { serveMcp } from '../shared/http.js';
import { loadItsmFixtures } from './fixtures.js';
import { createItsmServer } from './server.js';
import { ItsmStore } from './store.js';

const port = Number(process.env.ACP_MOCK_ITSM_PORT ?? 7303);
const fixtures = loadItsmFixtures();
// ONE store per process: the fresh-McpServer-per-POST door closes over it, so
// a draft created on one request is visible (and submittable) on the next.
const store = new ItsmStore(fixtures);
serveMcp({ port, createServer: (failure) => createItsmServer(store, fixtures, { failure }) });
console.log(`itsm mock MCP server listening on :${port}/mcp`);
