/**
 * Mock A2A JSON-RPC remote entrypoint (dev platform profile). Serves POST /a2a
 * (JSON-RPC 2.0) and GET /healthz on ACP_MOCK_A2A_PORT (default 7305). The
 * proxy adapter reaches it at http://localhost:7305/a2a with its OWN credential.
 *
 * Excluded from unit coverage (live socket); handleA2ARpc/authorized are
 * unit-tested and the E2E suite exercises the served door.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { authorized, handleA2ARpc, type JsonRpcRequest } from './server.js';

const port = Number(process.env.ACP_MOCK_A2A_PORT ?? 7305);
// The credential the adapter presents (ACP_PROXY_CREDENTIAL on the agent side).
const expectedCredential = process.env.ACP_MOCK_A2A_CREDENTIAL ?? 'external-echo-remote-dev-credential';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err), code: -32603 } });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/a2a') {
    sendJson(res, 404, { error: { message: 'not found', code: -32601 } });
    return;
  }

  // Trust boundary: only the adapter's own credential is accepted. If the
  // platform's delegated token ever reached here it would be rejected — the
  // E2E asserts the request nonetheless succeeds, proving the adapter used its
  // own credential.
  const auth = req.headers.authorization;
  if (!authorized(auth, expectedCredential)) {
    sendJson(res, 401, { error: { message: 'unauthorized: unexpected credential', code: -32001 } });
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as JsonRpcRequest;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const outcome = handleA2ARpc(request);
  sendJson(res, 200, { jsonrpc: '2.0', id: request.id ?? null, ...outcome });
}

server.listen(port);
console.log(`mock a2a remote listening on :${port}/a2a`);
