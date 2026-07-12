/**
 * The MCP door as a black box: a real Streamable HTTP round trip against a
 * stubbed SearchService — the door's job is translation (MCP frames ↔
 * SearchRequests, results ↔ ToolEnvelopes, AuthError ↔ typed wire errors),
 * so the tests drive exactly that and never re-test the PEP inside search().
 */

import { AuthError, JwtVerifier, createLogger } from '@acp/service-kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpToolClient, parseToolEnvelope } from '@acp/tool-client';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildKnowledgeApp } from '../src/app.js';
import { KNOWLEDGE_AUDIENCE, type SearchRequest, type SearchResult } from '../src/search.js';
import type { SearchService } from '../src/search.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('knowledge-mcp-test');

const RESULT: SearchResult = {
  content: 'A change freeze is in effect during the final week of each fiscal quarter.',
  score: 0.032,
  citation: {
    doc_id: 'policy/change-management',
    version: '3.2.0',
    effective_date: '2026-01-15',
    url: 'https://docs.acme.example/policy/change-management',
    lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
    snippet: 'A change freeze is in effect…',
  },
};
const SAME_DOC_RESULT: SearchResult = { ...RESULT, score: 0.02 };
const OTHER_RESULT: SearchResult = {
  content: 'TLS 1.3 is required for all new services.',
  score: 0.01,
  citation: {
    doc_id: 'standard/tls-configuration',
    version: '1.6.0',
    lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f43',
    snippet: 'TLS 1.3 is required…',
  },
};

const requests: SearchRequest[] = [];
let respond: () => Promise<SearchResult[]>;

let app: FastifyInstance;
let url: string;
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  key = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);
  const stub = {
    search(request: SearchRequest) {
      requests.push(request);
      return respond();
    },
  };
  app = buildKnowledgeApp({
    search: stub as unknown as SearchService,
    verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
    ingest: { ingestSource: () => Promise.resolve({ documents: 1, indexed: 3 }) },
    logger,
  });
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  url = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  requests.length = 0;
  respond = () => Promise.resolve([RESULT]);
});

async function makeToken(scope = 'knowledge:search:read'): Promise<string> {
  return new SignJWT({ sub: 'user:jane.doe', tenant: 'acme', roles: ['tenant-user'], scope })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(KNOWLEDGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const toolClient = () => new McpToolClient({ servers: { knowledge: { url } } });

/** Narrows a parsed envelope to its error, failing loudly on success shapes. */
function errorOf(envelope: ReturnType<typeof parseToolEnvelope>) {
  if (envelope === undefined || envelope.ok) {
    throw new Error(`expected an error envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error;
}

/** Raw MCP round trip so error envelopes can be inspected before mapping. */
async function rawCall(
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const client = new Client({ name: 'mcp-door-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  try {
    await client.connect(transport as Transport);
    return await client.callTool({ name: 'knowledge_search', arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe('tools/list', () => {
  it('serves the knowledge_search schema without authentication', async () => {
    const client = new Client({ name: 'mcp-door-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport as Transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['knowledge_search']);
      expect(tools[0]!.inputSchema).toMatchObject({
        type: 'object',
        required: ['query'],
        additionalProperties: false,
      });
    } finally {
      await client.close();
    }
  });
});

describe('knowledge_search happy path', () => {
  it('passes the token, query, k, source_id, and correlation headers into search()', async () => {
    const token = await makeToken();
    const response = await toolClient().call(
      'knowledge',
      'knowledge_search',
      { query: 'change freeze policy', k: 3, source_id: 'policy-docs' },
      {
        delegatedToken: token,
        taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
        stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      token,
      query: 'change freeze policy',
      k: 3,
      source_id: 'policy-docs',
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(response.data.results).toEqual([RESULT]);
    expect(response.provenance).toEqual([
      {
        doc_id: 'policy/change-management',
        version: '3.2.0',
        effective_date: '2026-01-15',
        url: 'https://docs.acme.example/policy/change-management',
        lineage_id: RESULT.citation.lineage_id,
      },
    ]);
  });

  it('dedupes provenance by lineage_id across results', async () => {
    respond = () => Promise.resolve([RESULT, SAME_DOC_RESULT, OTHER_RESULT]);
    const response = await toolClient().call(
      'knowledge',
      'knowledge_search',
      { query: 'q' },
      { delegatedToken: await makeToken() },
    );
    expect(response.provenance.map((p) => p.lineage_id)).toEqual([
      RESULT.citation.lineage_id,
      OTHER_RESULT.citation.lineage_id,
    ]);
    // OTHER_RESULT has no effective_date/url — the keys must be absent.
    expect(Object.keys(response.provenance[1]!)).toEqual(['doc_id', 'version', 'lineage_id']);
  });

  it('omits correlation fields when the headers are absent', async () => {
    await toolClient().call(
      'knowledge',
      'knowledge_search',
      { query: 'q' },
      { delegatedToken: await makeToken() },
    );
    expect(requests[0]!.task_id).toBeUndefined();
    expect(requests[0]!.step_id).toBeUndefined();
  });
});

describe('knowledge_search error mapping (all MCP results, never HTTP errors)', () => {
  it('missing Bearer token → upstream_auth envelope', async () => {
    const result = await rawCall({ query: 'q' });
    const envelope = parseToolEnvelope(result);
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'upstream_auth', message: 'missing Bearer token' },
    });
    expect(requests).toHaveLength(0);
  });

  it('AuthError 403 (Cedar deny inside the PEP) → upstream_auth', async () => {
    respond = () => Promise.reject(new AuthError('Cedar decision: deny for knowledge.search', 403));
    const result = await rawCall(
      { query: 'q' },
      { authorization: `Bearer ${await makeToken('task:submit')}` },
    );
    const error = errorOf(parseToolEnvelope(result));
    expect(error.code).toBe('upstream_auth');
    expect(error.message).toContain('Cedar decision: deny');
  });

  it('AuthError 400 → invalid_input', async () => {
    respond = () => Promise.reject(new AuthError('query is required', 400));
    const result = await rawCall({ query: '' }, { authorization: `Bearer ${await makeToken()}` });
    expect(parseToolEnvelope(result)).toEqual({
      ok: false,
      error: { code: 'invalid_input', message: 'query is required' },
    });
  });

  it('unknown internal failure → unavailable without leaking details', async () => {
    respond = () => Promise.reject(new Error('pg connection refused at 10.0.0.3'));
    const result = await rawCall({ query: 'q' }, { authorization: `Bearer ${await makeToken()}` });
    expect(parseToolEnvelope(result)).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'internal error during retrieval' },
    });
  });

  it('rejects malformed k and source_id before touching the service', async () => {
    const headers = { authorization: `Bearer ${await makeToken()}` };
    for (const args of [
      { query: 'q', k: 0 },
      { query: 'q', k: 1.5 },
      { query: 'q', source_id: 7 },
    ]) {
      const envelope = parseToolEnvelope(await rawCall(args, headers));
      expect(envelope).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(requests).toHaveLength(0);
  });

  it('unknown tool name → not_found', async () => {
    const client = new Client({ name: 'mcp-door-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport as Transport);
    try {
      const result = await client.callTool({ name: 'knowledge_fetch', arguments: {} });
      const error = errorOf(parseToolEnvelope(result));
      expect(error.code).toBe('not_found');
      expect(error.message).toContain('knowledge_fetch');
    } finally {
      await client.close();
    }
  });
});

describe('the HTTP doors still answer beside the MCP door', () => {
  it('serves /v1/search with a Bearer token and refuses without one', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'q' } });
    expect(anon.statusCode).toBe(401);

    const token = await makeToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'q' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ results: SearchResult[] }>().results).toEqual([RESULT]);
    expect(requests.at(-1)!.token).toBe(token);
  });

  it('gates /v1/ingest on the knowledge:ingest scope', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/ingest', payload: {} });
    expect(anon.statusCode).toBe(401);

    const wrongScope = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${await makeToken()}` },
      payload: { source_id: 'policy-docs' },
    });
    expect(wrongScope.statusCode).toBe(403);

    const missingSource = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${await makeToken('knowledge:ingest')}` },
      payload: {},
    });
    expect(missingSource.statusCode).toBe(400);

    const okRes = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      headers: { authorization: `Bearer ${await makeToken('knowledge:ingest')}` },
      payload: { source_id: 'policy-docs' },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json<{ documents: number }>().documents).toBe(1);
  });
});
