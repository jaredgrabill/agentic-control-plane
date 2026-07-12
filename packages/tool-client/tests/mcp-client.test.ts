import { createServer, type Server } from 'node:http';
import { CapabilityError } from '@acp/agent-sdk';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpToolClient, type ServerBinding, type ToolEnvelope } from '../src/index.js';

type ToolResult = CallToolResult;

/** A scripted MCP server reachable over a fresh in-memory pair per call. */
function bindingFor(name: string, result: () => Promise<ToolResult> | ToolResult): ServerBinding {
  return {
    transport: () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer({ name: 'scripted', version: '0.0.0' });
      server.registerTool(name, { description: 'scripted' }, () => result());
      void server.connect(serverTransport);
      return clientTransport;
    },
  };
}

function envelopeResult(envelope: ToolEnvelope): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: !envelope.ok,
  };
}

const PROVENANCE = [
  {
    doc_id: 'cloud/inventory-snapshot',
    version: '2026-07-08',
    lineage_id: '01981c00-0000-7000-8000-0000000000a1',
  },
];

async function failureOf(promise: Promise<unknown>): Promise<CapabilityError> {
  const outcome = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(CapabilityError);
  return outcome as CapabilityError;
}

describe('McpToolClient happy paths', () => {
  it('passes data, provenance, partial, and gaps through', async () => {
    const client = new McpToolClient({
      servers: {
        cloud: bindingFor('lookup', () =>
          envelopeResult({
            ok: true,
            data: { answer: 42 },
            provenance: PROVENANCE,
            partial: true,
            gaps: ['late billing'],
          }),
        ),
      },
    });
    const response = await client.call('cloud', 'lookup', { q: 'x' });
    expect(response).toEqual({
      data: { answer: 42 },
      provenance: PROVENANCE,
      partial: true,
      gaps: ['late billing'],
    });
  });

  it('omits partial/gaps keys when the envelope has none', async () => {
    const client = new McpToolClient({
      servers: {
        cloud: bindingFor('lookup', () => envelopeResult({ ok: true, data: {}, provenance: [] })),
      },
    });
    const response = await client.call('cloud', 'lookup', {});
    expect(Object.keys(response)).toEqual(['data', 'provenance']);
  });

  it('falls back to envelope JSON in content[0].text', async () => {
    const envelope: ToolEnvelope = { ok: true, data: { via: 'text' }, provenance: PROVENANCE };
    const client = new McpToolClient({
      servers: {
        cloud: bindingFor('lookup', () => ({
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
        })),
      },
    });
    const response = await client.call('cloud', 'lookup', {});
    expect(response.data).toEqual({ via: 'text' });
  });
});

describe('McpToolClient error mapping (normative table)', () => {
  const envelopeClient = (envelope: ToolEnvelope) =>
    new McpToolClient({ servers: { cloud: bindingFor('t', () => envelopeResult(envelope)) } });

  it('unknown server → permanent', async () => {
    const client = new McpToolClient({ servers: {} });
    const err = await failureOf(client.call('ghost', 't', {}));
    expect(err.errorClass).toBe('permanent');
    expect(err.message).toBe('no endpoint configured for tool server ghost');
  });

  it('network/connect failure → retryable unreachable', async () => {
    const client = new McpToolClient({
      servers: { cloud: { url: 'http://127.0.0.1:59999/mcp' } },
      timeoutMs: 2_000,
    });
    const err = await failureOf(client.call('cloud', 't', {}));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toContain('tool server cloud unreachable:');
  });

  it('request timeout → retryable with the timeout in the message', async () => {
    const client = new McpToolClient({
      servers: { cloud: bindingFor('t', () => new Promise<ToolResult>(() => undefined)) },
      timeoutMs: 50,
    });
    const err = await failureOf(client.call('cloud', 't', {}));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('tool cloud.t did not answer within 50ms');
  });

  it('envelope rate_limited → retryable with retry_after_s details', async () => {
    const err = await failureOf(
      envelopeClient({
        ok: false,
        error: { code: 'rate_limited', message: 'slow down', retry_after_s: 3 },
      }).call('cloud', 't', {}),
    );
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('tool cloud.t rate limited — retry after 3s');
    expect(err.details).toEqual({ retry_after_s: 3 });
  });

  it('envelope rate_limited without retry_after_s passes the message through', async () => {
    const err = await failureOf(
      envelopeClient({ ok: false, error: { code: 'rate_limited', message: 'slow down' } }).call(
        'cloud',
        't',
        {},
      ),
    );
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('slow down');
    expect(err.details).toBeUndefined();
  });

  it.each([
    ['unavailable', 'retryable'],
    ['upstream_auth', 'policy_denied'],
    ['invalid_input', 'permanent'],
    ['not_found', 'needs_input'],
  ] as const)('envelope %s → %s, message passed through', async (code, expectedClass) => {
    const err = await failureOf(
      envelopeClient({ ok: false, error: { code, message: `${code} happened` } }).call(
        'cloud',
        't',
        {},
      ),
    );
    expect(err.errorClass).toBe(expectedClass);
    expect(err.message).toBe(`${code} happened`);
  });

  it.each([
    [
      'isError without a parseable envelope',
      { content: [{ type: 'text' as const, text: 'BOOM' }], isError: true },
    ],
    ['malformed structuredContent', { content: [], structuredContent: { weird: true } }],
    [
      'ok:true without a provenance array',
      {
        content: [],
        structuredContent: { ok: true, data: {}, provenance: 'nope' },
      },
    ],
    [
      'unknown envelope error code',
      {
        content: [],
        structuredContent: { ok: false, error: { code: 'exploded', message: 'x' } },
        isError: true,
      },
    ],
  ])('%s → permanent malformed', async (_name, result) => {
    const client = new McpToolClient({
      servers: { cloud: bindingFor('t', () => result) },
    });
    const err = await failureOf(client.call('cloud', 't', {}));
    expect(err.errorClass).toBe('permanent');
    expect(err.message).toBe('tool cloud.t returned a malformed result');
  });
});

describe('McpToolClient HTTP auth statuses and header forwarding', () => {
  let httpServer: Server;
  interface SeenHeaders {
    'x-acp-test'?: string | undefined;
    authorization?: string | undefined;
    'x-acp-task-id'?: string | undefined;
    'x-acp-step-id'?: string | undefined;
  }
  const seen: SeenHeaders[] = [];
  let url: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      seen.push({
        'x-acp-test': req.headers['x-acp-test'] as string | undefined,
        authorization: req.headers.authorization,
        'x-acp-task-id': req.headers['x-acp-task-id'] as string | undefined,
        'x-acp-step-id': req.headers['x-acp-step-id'] as string | undefined,
      });
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('who are you?');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    url = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(() => {
    httpServer.close();
  });

  it('HTTP 401/403 → policy_denied refused, binding headers sent', async () => {
    seen.length = 0;
    const client = new McpToolClient({
      servers: { cloud: { url, headers: { 'x-acp-test': 'yes' } } },
    });
    const err = await failureOf(client.call('cloud', 't', {}));
    expect(err.errorClass).toBe('policy_denied');
    expect(err.message).toBe('tool server cloud refused the call (401)');
    expect(seen.map((h) => h['x-acp-test'])).toContain('yes');
    // No CallOptions → no identity or correlation headers fabricated.
    expect(seen.every((h) => h.authorization === undefined)).toBe(true);
    expect(seen.every((h) => h['x-acp-task-id'] === undefined)).toBe(true);
  });

  it('forwards the delegated token and correlation ids from CallOptions', async () => {
    seen.length = 0;
    const client = new McpToolClient({
      servers: { cloud: { url, headers: { 'x-acp-test': 'yes' } } },
    });
    await failureOf(
      client.call(
        'cloud',
        't',
        {},
        { delegatedToken: 'tok-123', taskId: 'task-1', stepId: 'step-1' },
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.authorization).toBe('Bearer tok-123');
      expect(headers['x-acp-task-id']).toBe('task-1');
      expect(headers['x-acp-step-id']).toBe('step-1');
      // Binding headers still ride along.
      expect(headers['x-acp-test']).toBe('yes');
    }
  });

  it('exchanges the delegated token before it becomes the bearer (item 0c)', async () => {
    seen.length = 0;
    const provided: string[] = [];
    const client = new McpToolClient({
      servers: { cloud: { url } },
      tokenProvider: (delegated) => {
        provided.push(delegated);
        return Promise.resolve(`tools-for-${delegated}`);
      },
    });
    await failureOf(client.call('cloud', 't', {}, { delegatedToken: 'delegated-abc' }));
    // The provider saw the raw delegated token exactly once...
    expect(provided).toEqual(['delegated-abc']);
    // ...and the wire only ever carried the exchanged token — never the
    // delegated one (a stolen step token must not reach the gateway).
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.authorization).toBe('Bearer tools-for-delegated-abc');
    }
  });

  it('surfaces a tokenProvider failure as its own CapabilityError', async () => {
    seen.length = 0;
    const client = new McpToolClient({
      servers: { cloud: { url } },
      tokenProvider: () =>
        Promise.reject(new CapabilityError('policy_denied', 'exchange refused (403)')),
    });
    const err = await failureOf(client.call('cloud', 't', {}, { delegatedToken: 'd' }));
    expect(err.errorClass).toBe('policy_denied');
    expect(err.message).toBe('exchange refused (403)');
    // The exchange failed, so no upstream call was attempted.
    expect(seen.length).toBe(0);
  });
});

describe('McpToolClient tokenProvider vs transport bindings', () => {
  it('does not exchange for transport-factory bindings (headers are ignored)', async () => {
    let providerCalls = 0;
    const client = new McpToolClient({
      servers: {
        cloud: bindingFor('t', () =>
          envelopeResult({ ok: true, data: { ok: 1 }, provenance: PROVENANCE }),
        ),
      },
      tokenProvider: (t) => {
        providerCalls += 1;
        return Promise.resolve(t);
      },
    });
    const response = await client.call('cloud', 't', {}, { delegatedToken: 'd' });
    expect(response.data).toEqual({ ok: 1 });
    expect(providerCalls).toBe(0);
  });
});
