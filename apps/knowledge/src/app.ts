import {
  AuthError,
  createHttpServer,
  scopesOf,
  type JwtVerifier,
  type Logger,
} from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { registerMcpDoor } from './mcp.js';
import { KNOWLEDGE_AUDIENCE, type SearchRequest, type SearchService } from './search.js';

export interface IngestStarter {
  ingestSource(sourceId: string): Promise<{ documents: number; indexed: number }>;
}

export interface KnowledgeAppDeps {
  search: SearchService;
  verifier: JwtVerifier;
  ingest: IngestStarter;
  logger: Logger;
}

export function buildKnowledgeApp(deps: KnowledgeAppDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'knowledge', logger: deps.logger });

  // The HTTP door: same governance as the NATS door — the SearchService
  // does verification, policy, and audit; transport is incidental.
  app.post('/v1/search', async (request) => {
    const body = (request.body ?? {}) as Omit<SearchRequest, 'token'>;
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ') !== true) {
      throw new AuthError('missing Bearer token');
    }
    const results = await deps.search.search({ ...body, token: header.slice('Bearer '.length) });
    return { results };
  });

  app.post('/v1/ingest', async (request) => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ') !== true) {
      throw new AuthError('missing Bearer token');
    }
    const claims = await deps.verifier.verify(header.slice('Bearer '.length), KNOWLEDGE_AUDIENCE);
    if (!scopesOf(claims).includes('knowledge:ingest')) {
      throw new AuthError(`principal ${claims.sub} lacks scope knowledge:ingest`, 403);
    }
    const body = (request.body ?? {}) as { source_id?: string };
    if (typeof body.source_id !== 'string' || body.source_id === '') {
      throw new AuthError('source_id is required', 400);
    }
    return deps.ingest.ingestSource(body.source_id);
  });

  // The MCP door (third transport): knowledge_search over the same
  // SearchService — the Tool Gateway forwards IDE-shaped and agent calls
  // here with a brokered acp:knowledge token.
  registerMcpDoor(app, { search: deps.search, logger: deps.logger });

  return app;
}
