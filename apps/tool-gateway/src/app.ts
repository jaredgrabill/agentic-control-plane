/**
 * The HTTP/MCP door: POST /mcp/:server terminates MCP per request.
 *
 * Order per request: unknown server → 404; missing/invalid Bearer → 401
 * (the only HTTP-level refusals — the Item 3 client maps them
 * policy_denied); then a fresh stateless Server + transport pair serves
 * tools/list and tools/call through the enforcement core, where every
 * further refusal is a typed ToolEnvelope. GET/DELETE /mcp/:server → 405
 * (no sessions, no SSE resumption in v1).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AuthError, createHttpServer, type JwtVerifier, type Logger } from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { acceptToolsAudience, AUDIENCE_DESCRIPTION, resolveCaller } from './caller.js';
import type { Correlation } from './broker.js';
import type { ToolServerConfig } from './config.js';
import type { ToolGatewayCore } from './core.js';

export interface ToolGatewayAppDeps {
  core: ToolGatewayCore;
  verifier: JwtVerifier;
  config: ToolServerConfig;
  logger: Logger;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildToolGatewayApp(deps: ToolGatewayAppDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'tool-gateway', logger: deps.logger });

  app.post<{ Params: { server: string } }>('/mcp/:server', async (request, reply) => {
    const serverId = request.params.server;
    // (1) Routing before authN: an unknown path is a 404, not a secret.
    if (!deps.config.servers.has(serverId)) {
      return reply.status(404).send({
        error: { message: `unknown tool server ${serverId}`, status: 404 },
      });
    }

    // (2) AuthN: delegated token with an accepted audience, consistent
    // actor. Failures are HTTP 401 — the one wire shape MCP clients map
    // to policy_denied without parsing a body.
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ') !== true) {
      throw new AuthError('missing Bearer token');
    }
    const token = header.slice('Bearer '.length);
    const claims = await deps.verifier.verifyWithAudience(
      token,
      acceptToolsAudience,
      AUDIENCE_DESCRIPTION,
    );
    const caller = resolveCaller(claims, token);

    // (3) Correlation headers: UUID-validated or dropped — audit joins
    // must never be poisoned by caller-controlled junk.
    const corr = correlationOf(request);

    // (4) A stateless per-request MCP pair (the mocks' pattern). The
    // low-level Server is deliberate: tool names and schemas here are
    // proxied per upstream, outside McpServer's zod-first model.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mcp = new Server(
      { name: 'acp-tool-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await deps.core.listTools(caller, serverId),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, (req) =>
      deps.core.callTool(caller, serverId, req.params.name, req.params.arguments ?? {}, corr),
    );

    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      // Cast bridges the SDK's `T | undefined` fields vs Transport's
      // optional ones under exactOptionalPropertyTypes.
      await mcp.connect(transport as Transport);
      // Fastify already parsed the body; hand it to the transport verbatim.
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      deps.logger.error({ err, serverId }, 'mcp transport failure');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
      }
      reply.raw.end(JSON.stringify({ error: { message: 'internal error', status: 500 } }));
    }
    return reply;
  });

  // (5) No sessions in v1: nothing to GET (SSE resumption) or DELETE.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp/:server',
      handler: (_request, reply) =>
        reply.status(405).send({
          error: {
            message: 'sessions are not supported — POST tools/list and tools/call',
            status: 405,
          },
        }),
    });
  }

  return app;
}

export function correlationOf(request: FastifyRequest): Correlation {
  return {
    taskId: uuidHeader(request, 'x-acp-task-id'),
    stepId: uuidHeader(request, 'x-acp-step-id'),
  };
}

function uuidHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !UUID_PATTERN.test(value)) return undefined;
  return value;
}
