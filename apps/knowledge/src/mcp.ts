/**
 * The MCP door: a third transport over the SAME governed retrieval path.
 * POST /mcp exposes one tool, knowledge_search, as a thin MCP shell over
 * the existing SearchService — verification, Cedar, classification
 * filtering, and the retrieval.served audit all run unchanged inside
 * search(); this module only translates MCP frames to SearchRequests and
 * SearchResults to ToolEnvelopes.
 *
 * Every refusal is a ToolEnvelope error inside an MCP result (never an
 * HTTP error): AuthError 401/403 → upstream_auth, 400 → invalid_input,
 * anything else → unavailable. The Tool Gateway's client mapping (Item 3)
 * then fires unchanged.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { fail, ok, toCallToolResult, type Provenance } from '@acp/tool-client';
import { AuthError, type Logger } from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SearchRequest, SearchResult } from './search.js';

/** The slice of SearchService the door needs — tests stub exactly this. */
export interface McpSearch {
  search(request: SearchRequest): Promise<SearchResult[]>;
}

export interface McpDoorDeps {
  search: McpSearch;
  logger: Logger;
}

export const KNOWLEDGE_SEARCH_TOOL = {
  name: 'knowledge_search',
  description:
    'Search the governed knowledge corpus. Results carry citations with ' +
    'document versions and lineage ids; access is decided per call from ' +
    'the delegated token.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', minLength: 1 },
      k: { type: 'integer', minimum: 1, maximum: 50 },
      source_id: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export function registerMcpDoor(app: FastifyInstance, deps: McpDoorDeps): void {
  app.post('/mcp', async (request, reply) => {
    // The low-level Server is the supported "advanced" surface: this door
    // publishes an exact JSON Schema (the gateway validates against it
    // verbatim) and builds a fresh stateless server per request — both
    // outside McpServer's zod-first, long-lived model.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'knowledge', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    // Tool schemas are public metadata; listing requires no token.
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [KNOWLEDGE_SEARCH_TOOL],
    }));
    server.setRequestHandler(CallToolRequestSchema, (req) =>
      callKnowledgeSearch(deps, request, req.params.name, req.params.arguments ?? {}),
    );

    // Stateless per-request pair (same pattern as the dev mocks): no
    // sessionIdGenerator means no session tracking, and enableJsonResponse
    // gives plain JSON instead of SSE. The raw response is handed to the
    // transport, so Fastify must not touch it afterwards.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // Cast bridges the SDK's `T | undefined` fields vs Transport's
      // optional ones under exactOptionalPropertyTypes.
      await server.connect(transport as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      deps.logger.error({ err }, 'mcp door transport failure');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
      }
      reply.raw.end(JSON.stringify({ error: { message: 'internal error', status: 500 } }));
    }
  });
}

async function callKnowledgeSearch(
  deps: McpDoorDeps,
  httpRequest: FastifyRequest,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (tool !== 'knowledge_search') {
    return toCallToolResult(
      fail('not_found', `unknown tool ${tool} — the knowledge door serves knowledge_search`),
    );
  }
  const header = httpRequest.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    return toCallToolResult(fail('upstream_auth', 'missing Bearer token'));
  }
  if (args.k !== undefined && (!Number.isInteger(args.k) || (args.k as number) < 1)) {
    return toCallToolResult(fail('invalid_input', 'k must be an integer between 1 and 50'));
  }
  if (args.source_id !== undefined && typeof args.source_id !== 'string') {
    return toCallToolResult(fail('invalid_input', 'source_id must be a string'));
  }

  try {
    const results = await deps.search.search({
      token: header.slice('Bearer '.length),
      // The service validates the query itself (400 → invalid_input below).
      query: args.query as string,
      ...(args.k !== undefined ? { k: Math.min(args.k as number, 50) } : {}),
      ...(args.source_id !== undefined ? { source_id: args.source_id } : {}),
      ...(correlation(httpRequest, 'x-acp-task-id', 'task_id') ?? {}),
      ...(correlation(httpRequest, 'x-acp-step-id', 'step_id') ?? {}),
    });
    return toCallToolResult(ok({ results }, provenanceOf(results)));
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.statusCode === 400) {
        return toCallToolResult(fail('invalid_input', err.message));
      }
      return toCallToolResult(fail('upstream_auth', err.message));
    }
    deps.logger.error({ err }, 'knowledge_search failed');
    return toCallToolResult(fail('unavailable', 'internal error during retrieval'));
  }
}

/** Document-granularity provenance: citations deduped by lineage_id. */
function provenanceOf(results: SearchResult[]): Provenance[] {
  const seen = new Map<string, Provenance>();
  for (const result of results) {
    const citation = result.citation;
    if (seen.has(citation.lineage_id)) continue;
    seen.set(citation.lineage_id, {
      doc_id: citation.doc_id,
      version: citation.version,
      lineage_id: citation.lineage_id,
      ...(citation.effective_date !== undefined ? { effective_date: citation.effective_date } : {}),
      ...(citation.url !== undefined ? { url: citation.url } : {}),
    });
  }
  return [...seen.values()];
}

function correlation(
  request: FastifyRequest,
  header: string,
  field: 'task_id' | 'step_id',
): Record<string, string> | undefined {
  const value = request.headers[header];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : { [field]: single };
}
