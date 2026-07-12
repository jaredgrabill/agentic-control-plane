/**
 * Stateless Streamable HTTP door for a mock MCP server: every POST /mcp is
 * handled by a fresh McpServer + transport pair (no sessions), which is all
 * the dev mocks need and keeps them restart-proof. GET /healthz answers the
 * platform readiness gate.
 *
 * Excluded from unit coverage (live sockets); the directive plumbing it
 * delegates to (parseFailureDirective/applyTimeout) is unit-tested and the
 * E2E suite exercises the served door.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { applyTimeout, parseFailureDirective, type FailureDirective } from './failure.js';

export interface ServeMcpOptions {
  port: number;
  createServer: (failure?: FailureDirective) => McpServer;
  sleep?: (ms: number) => Promise<void>;
}

export function serveMcp(options: ServeMcpOptions): Server {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: String(err), status: 500 } }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', status: 404 } }));
      return;
    }

    const header = req.headers['x-acp-mock-failure'];
    const directive = parseFailureDirective(
      (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('failure'),
    );
    await applyTimeout(directive, sleep);

    const body: unknown = JSON.parse(await readBody(req));
    const mcp = options.createServer(directive);
    // Stateless (no sessionIdGenerator = no session tracking), plain JSON
    // responses instead of SSE.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    // Cast bridges the SDK's `T | undefined` fields vs Transport's optional
    // ones under exactOptionalPropertyTypes.
    await mcp.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  }

  server.listen(options.port);
  return server;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
