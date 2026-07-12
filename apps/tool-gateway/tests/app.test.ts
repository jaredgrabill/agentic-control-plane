/**
 * The HTTP door end to end: a listening gateway on an ephemeral port, real
 * JWTs against a real JwtVerifier, a real McpToolClient as the caller, and
 * an in-process (InMemoryTransport) upstream behind the core — the full
 * request path minus the network to the upstream.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import { McpToolClient, ok, toCallToolResult } from '@acp/tool-client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildToolGatewayApp } from '../src/app.js';
import type { CredentialBroker } from '../src/broker.js';
import type { ToolServerConfig } from '../src/config.js';
import { ToolGatewayCore } from '../src/core.js';
import type { PolicyClient, PolicyDecision } from '../src/policy-client.js';
import { UpstreamPool } from '../src/upstream.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('tool-gateway-app-test');

const PROVENANCE = [
  { doc_id: 'scripted/doc', version: '1', lineage_id: '01981c00-0000-7000-8000-00000000beef' },
];

const upstreamBinding = {
  transport: (): Transport => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'scripted', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'probe', description: 'p', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler(
      CallToolRequestSchema,
      () => toCallToolResult(ok({ answered: true }, PROVENANCE)) as CallToolResult,
    );
    void server.connect(serverTransport);
    return clientTransport;
  },
};

const config: ToolServerConfig = {
  servers: new Map([
    [
      'scripted',
      {
        id: 'scripted',
        url: 'inmemory://scripted',
        auth: { mode: 'static-headers', headers: {} },
        tools: { probe: { scope: 'probe:read', risk: 'R0' } },
        rate_limit: { per_minute: 60, burst: 20 },
        timeout_ms: 15_000,
      },
    ],
  ]),
};

const auditEvents: AuditEvent[] = [];
let policyDecision: PolicyDecision;

let app: FastifyInstance;
let baseUrl: string;
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  key = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);

  const policy: PolicyClient = {
    authorize: () => Promise.resolve(policyDecision),
  };
  const broker: CredentialBroker = {
    headersFor: () => Promise.resolve({}),
  };
  const core = new ToolGatewayCore({
    config,
    upstreams: new UpstreamPool({ scripted: upstreamBinding }),
    policy,
    broker,
    limiter: { take: () => ({ allowed: true }) },
    audit: {
      publish: (event) => {
        auditEvents.push(event);
        return Promise.resolve();
      },
    },
    logger,
  });
  app = buildToolGatewayApp({
    core,
    verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
    config,
    logger,
  });
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  auditEvents.length = 0;
  policyDecision = {
    decision: 'allow',
    bundle_version: '2026.07+testtesttest',
    determining_policies: ['allow-something'],
  };
});

async function makeToken(overrides: Record<string, unknown> = {}, audience = 'acp:tools') {
  return new SignJWT({
    sub: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: 'probe:read',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

const client = () =>
  new McpToolClient({ servers: { scripted: { url: `${baseUrl}/mcp/scripted` } } });

async function classOf(promise: Promise<unknown>): Promise<{ cls: string; message: string }> {
  const err = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { errorClass: string; message: string };
  expect(err).toBeDefined();
  return { cls: err.errorClass, message: err.message };
}

describe('401 matrix (HTTP-level, mapped policy_denied by the client)', () => {
  it('no token → 401', async () => {
    const { cls, message } = await classOf(client().call('scripted', 'probe', {}));
    expect(cls).toBe('policy_denied');
    expect(message).toBe('tool server scripted refused the call (401)');
  });

  it('wrong audience (acp:gateway) → 401', async () => {
    const token = await makeToken({}, 'acp:gateway');
    const { cls } = await classOf(
      client().call('scripted', 'probe', {}, { delegatedToken: token }),
    );
    expect(cls).toBe('policy_denied');
  });

  it('old agent-audience token shape (acp:agent:{id}) → 401 at the door', async () => {
    // Post-flip, the whole acp:agent:* family is refused by audience alone —
    // a stolen delegated step token opens nothing here.
    const token = await makeToken(
      { act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } } },
      'acp:agent:cloud-agent',
    );
    const { cls } = await classOf(
      client().call('scripted', 'probe', {}, { delegatedToken: token }),
    );
    expect(cls).toBe('policy_denied');
  });

  it('acp:tools token acting as an agent with NO orchestrator chain → 401', async () => {
    // The agent-secret + stolen-subject-token forge: names an agent actor
    // but the chain does not bottom out at svc:orchestrator.
    const token = await makeToken({ act: { sub: 'agent:cloud-agent@0.1.0' } });
    const { cls } = await classOf(
      client().call('scripted', 'probe', {}, { delegatedToken: token }),
    );
    expect(cls).toBe('policy_denied');
  });

  it('garbage token → 401', async () => {
    const { cls } = await classOf(
      client().call('scripted', 'probe', {}, { delegatedToken: 'eyJhbGciOiJub25lIn0.e30.' }),
    );
    expect(cls).toBe('policy_denied');
  });
});

describe('accepted audiences', () => {
  it('acp:tools user token → end-to-end success against the in-process upstream', async () => {
    const taskId = randomUUID();
    const response = await client().call(
      'scripted',
      'probe',
      {},
      { delegatedToken: await makeToken(), taskId },
    );
    expect(response.data).toEqual({ answered: true });
    expect(response.provenance).toEqual(PROVENANCE);

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.actor.principal).toBe('user:jane.doe');
    expect(auditEvents[0]!.actor.delegation_chain).toEqual([{ sub: 'user:jane.doe' }]);
    expect(auditEvents[0]!.reason?.task_id).toBe(taskId);
  });

  it('acp:tools token acting as an agent, chain terminating at the orchestrator → success', async () => {
    const token = await makeToken({
      act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    });
    const response = await client().call('scripted', 'probe', {}, { delegatedToken: token });
    expect(response.data).toEqual({ answered: true });
    expect(auditEvents[0]!.actor.principal).toBe('agent:cloud-agent@0.1.0');
  });

  it('drops non-UUID correlation headers instead of recording junk', async () => {
    await client().call(
      'scripted',
      'probe',
      {},
      { delegatedToken: await makeToken(), taskId: 'not-a-uuid; DROP TABLE audit' },
    );
    expect(auditEvents[0]!.reason?.task_id).toBeUndefined();
  });
});

describe('refusals inside MCP (typed envelopes through the door)', () => {
  it('Cedar deny arrives as policy_denied via the envelope mapping', async () => {
    policyDecision = {
      decision: 'deny',
      bundle_version: '2026.07+testtesttest',
      determining_policies: [],
    };
    const { cls, message } = await classOf(
      client().call('scripted', 'probe', {}, { delegatedToken: await makeToken() }),
    );
    expect(cls).toBe('policy_denied');
    expect(message).toContain('Cedar decision: deny for tool:scripted:probe');
  });
});

describe('HTTP surface hygiene', () => {
  it('unknown server → 404 before authN', async () => {
    const res = await fetch(`${baseUrl}/mcp/ghost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('unknown tool server ghost');
  });

  it('GET and DELETE → 405 (no sessions in v1)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp/scripted`, { method });
      expect(res.status).toBe(405);
    }
  });

  it('healthz answers for the platform readiness gate', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});
