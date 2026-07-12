/**
 * The enforcement pipeline over REAL MCP marshalling: a live UpstreamPool
 * speaks InMemoryTransport to the @acp/mock-tools cloud server and to a
 * scripted low-level server, while policy/broker/limiter/audit are
 * counting fakes — so the tests can pin the ORDER of the pipeline (a
 * Cedar deny must never reach the limiter, the broker, or the upstream),
 * not just its outcomes.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AuditEvent } from '@acp/protocol';
import { createLogger, sha256Digest, type PlatformClaims } from '@acp/service-kit';
import { fail, ok, parseToolEnvelope, toCallToolResult } from '@acp/tool-client';
import { createCloudServer, loadCloudFixtures } from '@acp/mock-tools';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveCaller, type Caller } from '../src/caller.js';
import type { ToolServerConfig, ToolServerEntry } from '../src/config.js';
import { DevCredentialBroker, type CredentialBroker } from '../src/broker.js';
import { ToolGatewayCore, type KillSwitch } from '../src/core.js';
import type { PolicyClient, PolicyDecision } from '../src/policy-client.js';
import type { RateLimiter, TakeResult } from '../src/rate-limit.js';
import { UpstreamPool } from '../src/upstream.js';

const logger = createLogger('tool-gateway-core-test');
const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/acme-corp', import.meta.url));
const fixtures = loadCloudFixtures(FIXTURES_DIR);

const PROVENANCE = [
  { doc_id: 'scripted/doc', version: '1', lineage_id: '01981c00-0000-7000-8000-00000000dead' },
];

// ---------------------------------------------------------------- callers

function claimsFor(overrides: Partial<PlatformClaims>): PlatformClaims {
  return {
    sub: 'user:jane.doe',
    aud: 'acp:tools',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: '',
    ...overrides,
  };
}

const agentCaller = (scope = 'cloud:inventory:read cloud:cost:read'): Caller =>
  resolveCaller(
    claimsFor({
      // Post-0c: an agent presents an acp:tools token whose chain terminates
      // at the orchestrator; the Agent principal derives from act.sub.
      aud: 'acp:tools',
      scope,
      act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    }),
    'raw-tools-jwt',
  );

const userCaller = (scope = 'probe:read'): Caller =>
  resolveCaller(claimsFor({ scope }), 'raw-user-jwt');

// ------------------------------------------------------------- upstreams

/** Scripted low-level server: counts tools/call and answers per script. */
function scriptedBinding(counter: { calls: number }, respond: () => Promise<CallToolResult>) {
  return {
    transport: (): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const server = new Server(
        { name: 'scripted', version: '0.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          {
            name: 'probe',
            description: 'scripted probe',
            inputSchema: {
              type: 'object',
              properties: { limit: { type: 'integer', minimum: 1 } },
              additionalProperties: false,
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, () => {
        counter.calls += 1;
        return respond();
      });
      void server.connect(serverTransport);
      return clientTransport;
    },
  };
}

const cloudBinding = {
  transport: (): Transport => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void createCloudServer(fixtures).connect(serverTransport);
    return clientTransport;
  },
};

// ------------------------------------------------------------------ fakes

class FakePolicy implements PolicyClient {
  requests: Parameters<PolicyClient['authorize']>[0][] = [];
  decision: PolicyDecision = {
    decision: 'allow',
    bundle_version: '2026.07+testtesttest',
    determining_policies: ['allow-tool-cloud-estate-inventory'],
  };
  authorize(request: Parameters<PolicyClient['authorize']>[0]): Promise<PolicyDecision> {
    this.requests.push(request);
    return Promise.resolve(this.decision);
  }
}

class FakeBroker implements CredentialBroker {
  calls = 0;
  failure: Error | undefined;
  headersFor(): Promise<Record<string, string>> {
    this.calls += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({ 'x-acp-broker-credential': 'fake-cred' });
  }
}

class FakeLimiter implements RateLimiter {
  calls = 0;
  result: TakeResult = { allowed: true };
  take(): TakeResult {
    this.calls += 1;
    return this.result;
  }
}

interface Harness {
  core: ToolGatewayCore;
  policy: FakePolicy;
  broker: FakeBroker;
  limiter: FakeLimiter;
  audit: AuditEvent[];
  scriptedCalls: { calls: number };
  killSwitch: { fleet: boolean; suspended: Set<string>; denied: Set<string> };
  config: ToolServerConfig;
}

let scriptedRespond: () => Promise<CallToolResult>;

function makeHarness(options: { scriptedTimeoutMs?: number; auditFails?: boolean } = {}): Harness {
  const scriptedCalls = { calls: 0 };
  scriptedRespond = () =>
    Promise.resolve(toCallToolResult(ok({ probed: true }, PROVENANCE)) as CallToolResult);

  const config: ToolServerConfig = {
    servers: new Map([
      [
        'cloud-estate',
        {
          id: 'cloud-estate',
          url: 'inmemory://cloud-estate',
          auth: { mode: 'static-headers', headers: { 'x-acp-broker-credential': 'cloud-cred' } },
          tools: {
            inventory_search: { scope: 'cloud:inventory:read', risk: 'R0' },
            cost_report: { scope: 'cloud:cost:read', risk: 'R0' },
          },
          rate_limit: { per_minute: 60, burst: 20 },
          timeout_ms: 15_000,
        },
      ],
      [
        'scripted',
        {
          id: 'scripted',
          url: 'inmemory://scripted',
          auth: { mode: 'static-headers', headers: {} },
          tools: {
            probe: { scope: 'probe:read', risk: 'R0' },
            draft_probe: { scope: 'probe:draft', risk: 'R1' },
            write_probe: { scope: 'probe:write', risk: 'R2' },
            disabled_probe: { scope: 'probe:admin', risk: 'R3' },
          },
          rate_limit: { per_minute: 60, burst: 20 },
          timeout_ms: options.scriptedTimeoutMs ?? 15_000,
        },
      ],
    ]),
  };

  const upstreams = new UpstreamPool({
    'cloud-estate': cloudBinding,
    scripted: scriptedBinding(scriptedCalls, () => scriptedRespond()),
  });

  const policy = new FakePolicy();
  const broker = new FakeBroker();
  const limiter = new FakeLimiter();
  const audit: AuditEvent[] = [];
  const killSwitch = { fleet: false, suspended: new Set<string>(), denied: new Set<string>() };
  const killSwitchView: KillSwitch = {
    fleetHalt: () => (killSwitch.fleet ? { active: true, reason: 'drill' } : undefined),
    agentSuspension: (agentId) =>
      killSwitch.suspended.has(agentId) ? { active: true } : undefined,
    principalDenied: (sub) => (killSwitch.denied.has(sub) ? { active: true } : undefined),
  };

  const core = new ToolGatewayCore({
    config,
    upstreams,
    policy,
    broker,
    limiter,
    audit: {
      publish: (event) => {
        if (options.auditFails === true) return Promise.reject(new Error('stream down'));
        audit.push(event);
        return Promise.resolve();
      },
    },
    killSwitch: killSwitchView,
    logger,
    now: () => new Date('2026-07-11T12:00:00Z'),
  });
  return { core, policy, broker, limiter, audit, scriptedCalls, killSwitch, config };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

const CORR = {
  taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
  stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
};

function envelopeOf(result: CallToolResult) {
  return parseToolEnvelope(result);
}

function errorOf(result: CallToolResult) {
  const envelope = envelopeOf(result);
  if (envelope === undefined || envelope.ok) {
    throw new Error(`expected an error envelope, got ${JSON.stringify(envelope)}`);
  }
  return envelope.error;
}

describe('happy path (cloud fixture server over real MCP)', () => {
  it('forwards, returns the upstream envelope verbatim, and audits ok with lineage', async () => {
    const args = { service: 'payments-api', env: 'prod' };
    const result = await h.core.callTool(
      agentCaller(),
      'cloud-estate',
      'inventory_search',
      args,
      CORR,
    );

    const envelope = envelopeOf(result);
    if (envelope?.ok !== true) {
      throw new Error(`expected a success envelope, got ${JSON.stringify(envelope)}`);
    }
    expect((envelope.data as { total_matched: number }).total_matched).toBeGreaterThan(0);

    expect(h.audit).toHaveLength(1);
    const event = h.audit[0]!;
    expect(event.event_type).toBe('tool.called');
    expect(event.tenant).toBe('acme');
    expect(event.actor.principal).toBe('agent:cloud-agent@0.1.0');
    expect(event.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:cloud-agent@0.1.0',
    ]);
    expect(event.action.name).toBe('tool:cloud-estate:inventory_search');
    expect(event.action.inputs_digest).toBe(sha256Digest(JSON.stringify(args)));
    expect(event.reason?.task_id).toBe(CORR.taskId);
    expect(event.reason?.step_id).toBe(CORR.stepId);
    expect(event.reason?.policy).toEqual({
      decision: 'allow',
      bundle_version: '2026.07+testtesttest',
      determining_policies: ['allow-tool-cloud-estate-inventory'],
    });
    expect(event.artifacts?.lineage_ids).toEqual(['01981c00-0000-7000-8000-0000000000a1']);
    expect(event.details).toMatchObject({
      server: 'cloud-estate',
      tool: 'inventory_search',
      outcome: 'ok',
    });

    // The Cedar request carried the acting principal and delegated scopes.
    expect(h.policy.requests[0]).toMatchObject({
      principal: { type: 'Agent', id: 'agent:cloud-agent@0.1.0', attrs: { tenant: 'acme' } },
      action: 'tool:cloud-estate:inventory_search',
      resource: { type: 'Service', id: 'svc:cloud-estate', attrs: {} },
      context: { scopes: ['cloud:inventory:read', 'cloud:cost:read'], tenant: 'acme' },
    });
  });

  it('passes partial/gaps envelopes through verbatim', async () => {
    scriptedRespond = () =>
      Promise.resolve(
        toCallToolResult(
          ok({ half: true }, PROVENANCE, { partial: true, gaps: ['billing lag'] }),
        ) as CallToolResult,
      );
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    const envelope = envelopeOf(result);
    expect(envelope).toMatchObject({ ok: true, partial: true, gaps: ['billing lag'] });
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'ok' });
  });

  it('passes upstream typed error envelopes through verbatim and audits error:{code}', async () => {
    scriptedRespond = () =>
      Promise.resolve(
        toCallToolResult(fail('not_found', 'repo ghost is not known')) as CallToolResult,
      );
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(errorOf(result)).toEqual({ code: 'not_found', message: 'repo ghost is not known' });
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'error:not_found' });
    expect(h.audit[0]!.artifacts).toBeUndefined();
  });
});

describe('pipeline order (fake call counts pin it)', () => {
  it('Cedar deny → refusal BEFORE limiter, broker, and upstream; audit denied', async () => {
    h.policy.decision = {
      decision: 'deny',
      bundle_version: '2026.07+testtesttest',
      determining_policies: [],
    };
    const result = await h.core.callTool(
      agentCaller(),
      'cloud-estate',
      'inventory_search',
      {},
      CORR,
    );

    const error = errorOf(result);
    expect(error.code).toBe('upstream_auth');
    expect(error.message).toContain('Cedar decision: deny for tool:cloud-estate:inventory_search');
    expect(error.message).toContain('agent:cloud-agent@0.1.0');

    expect(h.policy.requests).toHaveLength(1);
    expect(h.limiter.calls).toBe(0);
    expect(h.broker.calls).toBe(0);
    expect(h.scriptedCalls.calls).toBe(0);

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'denied' });
    expect(h.audit[0]!.reason?.policy?.decision).toBe('deny');
  });

  it('rate limit refusal → after Cedar, before broker and upstream', async () => {
    h.limiter.result = { allowed: false, retryAfterS: 7 };
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});

    const error = errorOf(result);
    expect(error.code).toBe('rate_limited');
    expect(error.message).toBe('tool scripted/probe rate limited for tenant acme — retry after 7s');
    expect(error.retry_after_s).toBe(7);

    expect(h.policy.requests).toHaveLength(1); // Cedar ran (denials don't consume quota — quota runs after)
    expect(h.broker.calls).toBe(0);
    expect(h.scriptedCalls.calls).toBe(0);
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'rate_limited', retry_after_s: 7 });
  });

  it('invalid arguments → refused against the upstream schema before brokering', async () => {
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', { limit: 'many' }, {});
    const error = errorOf(result);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('invalid arguments for scripted/probe');
    expect(error.message).toContain('/limit');

    expect(h.broker.calls).toBe(0);
    expect(h.scriptedCalls.calls).toBe(0);
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'error:invalid_input' });
  });
});

describe('kill switch (before everything, no audit — no decision to record)', () => {
  it('fleet halt refuses every call', async () => {
    h.killSwitch.fleet = true;
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(errorOf(result)).toMatchObject({
      code: 'upstream_auth',
      message: 'platform fleet halt is active — tool calls are refused',
    });
    expect(h.policy.requests).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it('agent suspension refuses that agent only', async () => {
    h.killSwitch.suspended.add('cloud-agent');
    const suspended = await h.core.callTool(
      agentCaller(),
      'cloud-estate',
      'inventory_search',
      {},
      {},
    );
    expect(errorOf(suspended)).toMatchObject({
      code: 'upstream_auth',
      message: 'agent cloud-agent is suspended (kill switch)',
    });
    expect(h.policy.requests).toHaveLength(0);

    // A user is not the suspended agent — the call proceeds.
    const fine = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(envelopeOf(fine)).toMatchObject({ ok: true });
  });

  // 0c QA MEDIUM backstop: a denylisted principal's outstanding ≤15min
  // acp:tools token must open nothing, and a denylisted user/service must be
  // refused at the gateway too — not only at broker time.
  it('refuses a call whose acting agent principal is denylisted', async () => {
    h.killSwitch.denied.add('agent:cloud-agent@0.1.0');
    const result = await h.core.callTool(agentCaller(), 'cloud-estate', 'inventory_search', {}, {});
    expect(errorOf(result)).toMatchObject({
      code: 'upstream_auth',
      message: 'principal agent:cloud-agent@0.1.0 is denylisted (kill switch)',
    });
    expect(h.policy.requests).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it('refuses when the ORIGINAL subject is denylisted, even acting as an agent', async () => {
    // The chain started from user:jane.doe; denylisting the user must revoke
    // the agent token minted on their behalf (backstop checks caller.sub too).
    h.killSwitch.denied.add('user:jane.doe');
    const result = await h.core.callTool(agentCaller(), 'cloud-estate', 'inventory_search', {}, {});
    expect(errorOf(result)).toMatchObject({
      code: 'upstream_auth',
      message: 'principal user:jane.doe is denylisted (kill switch)',
    });
    expect(h.policy.requests).toHaveLength(0);
  });

  it('refuses a denylisted user principal directly', async () => {
    h.killSwitch.denied.add('user:jane.doe');
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(errorOf(result)).toMatchObject({
      code: 'upstream_auth',
      message: 'principal user:jane.doe is denylisted (kill switch)',
    });
  });

  it('a non-denylisted principal proceeds normally (no false positive)', async () => {
    h.killSwitch.denied.add('user:someone-else');
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(envelopeOf(result)).toMatchObject({ ok: true });
  });
});

describe('governed lookup', () => {
  it('an ungoverned tool is refused before Cedar with a pointer to the config', async () => {
    const result = await h.core.callTool(agentCaller(), 'cloud-estate', 'run_command', {}, {});
    expect(errorOf(result)).toMatchObject({
      code: 'not_found',
      message:
        'tool run_command is not governed on server cloud-estate — see deploy/dev/tool-servers.json',
    });
    expect(h.policy.requests).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it('an unknown server is equally not governed', async () => {
    const result = await h.core.callTool(agentCaller(), 'ghost', 'anything', {}, {});
    expect(errorOf(result)).toMatchObject({ code: 'not_found' });
  });
});

describe('upstream failures', () => {
  it('timeout → unavailable (retryable at the client)', async () => {
    h = makeHarness({ scriptedTimeoutMs: 150 });
    scriptedRespond = () => new Promise<CallToolResult>(() => undefined);
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    const error = errorOf(result);
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('tool server scripted did not answer:');
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'error:unavailable' });
  });

  it('malformed upstream result → substituted envelope-less isError (client maps permanent)', async () => {
    scriptedRespond = () =>
      Promise.resolve({ content: [{ type: 'text', text: 'BOOM' }] } as CallToolResult);
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toBeUndefined();
    expect((result.content as { text: string }[])[0]!.text).toBe(
      'upstream tool scripted/probe returned a result that failed schema validation',
    );
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'error:malformed' });
  });

  it('broker failure → upstream_auth passthrough, upstream never contacted', async () => {
    h.broker.failure = new Error('vault sealed');
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(errorOf(result)).toMatchObject({ code: 'upstream_auth', message: 'vault sealed' });
    expect(h.scriptedCalls.calls).toBe(0);
    expect(h.audit[0]!.details).toMatchObject({ outcome: 'error:upstream_auth' });
  });
});

describe('audit resilience', () => {
  it('R0 alarm-and-continue: a failing audit sink does not refuse the call', async () => {
    h = makeHarness({ auditFails: true });
    const result = await h.core.callTool(userCaller(), 'scripted', 'probe', {}, {});
    expect(envelopeOf(result)).toMatchObject({ ok: true });
  });
});

describe('listTools (progressive disclosure v1)', () => {
  it('serves the upstream list ∩ governed tools, filtered to the caller scopes', async () => {
    const inventoryOnly = await h.core.listTools(
      agentCaller('cloud:inventory:read'),
      'cloud-estate',
    );
    expect(inventoryOnly.map((t) => t.name)).toEqual(['inventory_search']);

    const both = await h.core.listTools(agentCaller(), 'cloud-estate');
    expect(both.map((t) => t.name).sort()).toEqual(['cost_report', 'inventory_search']);

    expect(await h.core.listTools(agentCaller(), 'ghost')).toEqual([]);
    expect(await h.core.listTools(agentCaller('task:submit'), 'cloud-estate')).toEqual([]);
  });
});

// ------------------------------------------------- header discipline (HTTP)

describe('static headers over real HTTP: broker credential in, caller Authorization NEVER', () => {
  let httpServer: HttpServer;
  const seenHeaders: { method: string; headers: Record<string, string | string[] | undefined> }[] =
    [];

  afterAll(() => {
    httpServer.close();
  });

  it('injects broker + correlation headers only', async () => {
    httpServer = createServer((req, res) => {
      seenHeaders.push({ method: req.method ?? '', headers: { ...req.headers } });
      if (req.method !== 'POST') {
        // Transport teardown (GET/DELETE) — nothing to serve statelessly.
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const server = new Server(
            { name: 'http-upstream', version: '0.0.0' },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: [{ name: 'probe', description: 'p', inputSchema: { type: 'object' } }],
          }));
          server.setRequestHandler(
            CallToolRequestSchema,
            () => toCallToolResult(ok({ via: 'http' }, PROVENANCE)) as CallToolResult,
          );
          const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
          await server.connect(transport as Transport);
          await transport.handleRequest(
            req,
            res,
            JSON.parse(Buffer.concat(chunks).toString('utf-8')),
          );
        })();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const config: ToolServerConfig = {
      servers: new Map([
        [
          'httpup',
          {
            id: 'httpup',
            url: `http://127.0.0.1:${port}/mcp`,
            auth: { mode: 'static-headers', headers: { 'x-acp-broker-credential': 'secret-cred' } },
            tools: { probe: { scope: 'probe:read', risk: 'R0' } },
            rate_limit: { per_minute: 60, burst: 20 },
            timeout_ms: 15_000,
          },
        ],
      ]),
    };
    const audit: AuditEvent[] = [];
    const core = new ToolGatewayCore({
      config,
      upstreams: new UpstreamPool({ httpup: { url: `http://127.0.0.1:${port}/mcp` } }),
      policy: new FakePolicy(),
      // The REAL broker in static mode — this is the production header path.
      broker: new DevCredentialBroker({ tokenUrl: 'unused', clientId: 'x', clientSecret: 'y' }),
      limiter: new FakeLimiter(),
      audit: {
        publish: (e) => {
          audit.push(e);
          return Promise.resolve();
        },
      },
      logger,
    });

    const result = await core.callTool(userCaller(), 'httpup', 'probe', {}, CORR);
    expect(envelopeOf(result)).toMatchObject({ ok: true, data: { via: 'http' } });

    // tools/list + tools/call both hit the upstream; on the CALL request the
    // broker credential and correlation are present and the caller's
    // Authorization is structurally absent — on EVERY request.
    const callRequest = seenHeaders.filter((r) => r.method === 'POST').at(-1)!;
    expect(callRequest.headers['x-acp-broker-credential']).toBe('secret-cred');
    expect(callRequest.headers['x-acp-task-id']).toBe(CORR.taskId);
    expect(callRequest.headers['x-acp-step-id']).toBe(CORR.stepId);
    expect(seenHeaders.length).toBeGreaterThan(0);
    for (const request of seenHeaders) {
      expect(request.headers.authorization).toBeUndefined();
    }
  });
});

describe('DevCredentialBroker token-exchange mode (injected fetch)', () => {
  const entry: ToolServerEntry = {
    id: 'knowledge',
    url: 'http://localhost:7105/mcp',
    auth: { mode: 'token-exchange', audience: 'acp:knowledge', scope: ['knowledge:search:read'] },
    tools: { knowledge_search: { scope: 'knowledge:search:read', risk: 'R0' } },
    rate_limit: { per_minute: 60, burst: 5 },
    timeout_ms: 15_000,
  };

  it('exchanges the caller token with actor preserved and returns the bearer', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'exchanged-token' }), { status: 200 }),
      );
    }) as typeof fetch;
    const broker = new DevCredentialBroker({
      tokenUrl: 'http://localhost:7101',
      clientId: 'svc-tool-gateway',
      clientSecret: 'tool-gateway-dev-secret',
      fetchImpl,
    });

    const headers = await broker.headersFor(entry, agentCaller(), { taskId: CORR.taskId });
    expect(headers).toEqual({
      authorization: 'Bearer exchanged-token',
      'x-acp-task-id': CORR.taskId,
    });
    expect(requests[0]!.url).toBe('http://localhost:7101/v1/token/exchange');
    expect(requests[0]!.body).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'svc-tool-gateway',
      client_secret: 'tool-gateway-dev-secret',
      subject_token: 'raw-tools-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      audience: 'acp:knowledge',
      scope: 'knowledge:search:read',
      actor: 'agent:cloud-agent@0.1.0',
    });
  });

  it('surfaces a refused exchange with status and body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('no such client', { status: 401 }))) as typeof fetch;
    const broker = new DevCredentialBroker({
      tokenUrl: 'http://localhost:7101',
      clientId: 'x',
      clientSecret: 'y',
      fetchImpl,
    });
    await expect(broker.headersFor(entry, userCaller(), {})).rejects.toThrow(
      /could not exchange the caller token for knowledge: 401 no such client/,
    );
  });
});

// -------------------------------------------------- require-approval (v1)

const APPROVAL_TASK_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
const APPROVAL_STEP_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51';
const APPROVAL_DIGEST = `sha256:${'a'.repeat(64)}`;

/** An agent caller whose acp:tools token carries brokered + approval claims. */
function approvedAgentCaller(
  over: { taskId?: string; stepId?: string; scope?: string } = {},
): Caller {
  return resolveCaller(
    claimsFor({
      aud: 'acp:tools',
      scope: over.scope ?? 'cloud:inventory:read cloud:cost:read',
      act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
      brokered: { task_id: over.taskId ?? APPROVAL_TASK_ID, verified_at: '2026-07-11T09:00:00Z' },
      approval: {
        id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90',
        decision_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f91',
        approver: 'user:approver.ops',
        step_id: over.stepId ?? APPROVAL_STEP_ID,
        capability: 'cloud.tag_apply',
        subject_digest: APPROVAL_DIGEST,
      },
    }),
    'raw-tools-jwt',
  );
}

describe('require-approval (verify-only PEP fails closed)', () => {
  it('refuses a require-approval decision when the token has no approval claim, with audit', async () => {
    h.policy.decision = {
      decision: 'require-approval',
      bundle_version: '2026.07+gate',
      determining_policies: ['gate-r2-delegation'],
    };
    const result = await h.core.callTool(agentCaller(), 'cloud-estate', 'inventory_search', {}, {});
    expect(errorOf(result)).toMatchObject({ code: 'upstream_auth' });
    expect(errorOf(result).message).toContain('require-approval');
    expect(errorOf(result).message).toContain('no approval grounds');
    // Audited as denied, no upstream contact.
    const event = h.audit.at(-1)!;
    expect((event.details as { outcome: string }).outcome).toBe('denied');
    expect(h.broker.calls).toBe(0);
  });

  it('sends context.approval.granted=false when there is no claim', async () => {
    await h.core.callTool(agentCaller(), 'cloud-estate', 'inventory_search', {}, {});
    const ctx = h.policy.requests.at(-1)!.context as { approval: { granted: boolean } };
    expect(ctx.approval).toEqual({ granted: false });
  });

  it('binds context.approval.granted=true when the claim matches the correlation task+step', async () => {
    await h.core.callTool(
      approvedAgentCaller(),
      'cloud-estate',
      'inventory_search',
      {},
      { taskId: APPROVAL_TASK_ID, stepId: APPROVAL_STEP_ID },
    );
    const ctx = h.policy.requests.at(-1)!.context as {
      approval: { granted: boolean; capability?: string; step_id?: string; approval_id?: string };
    };
    expect(ctx.approval).toMatchObject({
      granted: true,
      capability: 'cloud.tag_apply',
      step_id: APPROVAL_STEP_ID,
    });
  });

  it('does NOT bind when the correlation step differs from the claim (replay onto another step)', async () => {
    await h.core.callTool(
      approvedAgentCaller(),
      'cloud-estate',
      'inventory_search',
      {},
      { taskId: APPROVAL_TASK_ID, stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f77' },
    );
    const ctx = h.policy.requests.at(-1)!.context as { approval: { granted: boolean } };
    expect(ctx.approval.granted).toBe(false);
  });

  it('does NOT bind when correlation is absent (no task/step to bind to)', async () => {
    await h.core.callTool(approvedAgentCaller(), 'cloud-estate', 'inventory_search', {}, {});
    const ctx = h.policy.requests.at(-1)!.context as { approval: { granted: boolean } };
    expect(ctx.approval.granted).toBe(false);
  });

  it('does NOT bind when the brokered task differs from the correlation task', async () => {
    await h.core.callTool(
      approvedAgentCaller({ taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f99' }),
      'cloud-estate',
      'inventory_search',
      {},
      { taskId: APPROVAL_TASK_ID, stepId: APPROVAL_STEP_ID },
    );
    const ctx = h.policy.requests.at(-1)!.context as { approval: { granted: boolean } };
    expect(ctx.approval.granted).toBe(false);
  });

  it('a bound approval still requires Cedar allow — a require-approval verdict refuses even when a claim is present', async () => {
    // Carries the unbound approval id into the refusal audit for investigation.
    h.policy.decision = {
      decision: 'require-approval',
      bundle_version: '2026.07+gate',
      determining_policies: ['gate-r2-delegation'],
    };
    const result = await h.core.callTool(
      approvedAgentCaller({ stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f88' }),
      'cloud-estate',
      'inventory_search',
      {},
      { taskId: APPROVAL_TASK_ID, stepId: APPROVAL_STEP_ID },
    );
    expect(errorOf(result).code).toBe('upstream_auth');
    const event = h.audit.at(-1)!;
    expect((event.details as { approval_id?: string }).approval_id).toBe(
      '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90',
    );
  });
});

// ------------------------------------------- risk-class enforcement (item 3)

const RISK_TASK_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
const RISK_STEP_ID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44';

/** An agent caller whose acp:tools token carries a capability claim of `risk`. */
function capabilityAgentCaller(
  capability: { name: string; risk: string } | undefined,
  over: { taskId?: string; scope?: string; compensation?: PlatformClaims['compensation'] } = {},
): Caller {
  return resolveCaller(
    claimsFor({
      aud: 'acp:tools',
      scope: over.scope ?? 'probe:read probe:draft probe:write probe:admin',
      act: { sub: 'agent:change-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
      brokered: { task_id: over.taskId ?? RISK_TASK_ID, verified_at: '2026-07-11T09:00:00Z' },
      ...(capability === undefined ? {} : { capability }),
      ...(over.compensation === undefined ? {} : { compensation: over.compensation }),
    }),
    'raw-tools-jwt',
  );
}

describe('structural risk-class enforcement (step 3.5)', () => {
  const cap = (risk: string) => ({ name: 'change.step', risk });

  it('an R3 tool is refused unconditionally, even from an R3 capability context', async () => {
    const result = await h.core.callTool(
      capabilityAgentCaller(cap('R3')),
      'scripted',
      'disabled_probe',
      {},
      CORR,
    );
    expect(errorOf(result).code).toBe('upstream_auth');
    expect(errorOf(result).message).toContain('R3 tools are disabled');
    expect(h.scriptedCalls.calls).toBe(0);
    expect(h.limiter.calls).toBe(0); // refused before the limiter
  });

  it('refuses an R2 tool from an R0 and an R1 capability context (matrix)', async () => {
    for (const risk of ['R0', 'R1']) {
      const result = await h.core.callTool(
        capabilityAgentCaller(cap(risk)),
        'scripted',
        'write_probe',
        {},
        CORR,
      );
      expect(errorOf(result).code, risk).toBe('upstream_auth');
      expect(errorOf(result).message, risk).toContain('exceeds capability risk');
    }
    expect(h.scriptedCalls.calls).toBe(0);
  });

  it('refuses an R1 tool from an R0 context but allows it from an R1 context', async () => {
    const refused = await h.core.callTool(
      capabilityAgentCaller(cap('R0')),
      'scripted',
      'draft_probe',
      {},
      CORR,
    );
    expect(errorOf(refused).code).toBe('upstream_auth');
    const allowed = await h.core.callTool(
      capabilityAgentCaller(cap('R1')),
      'scripted',
      'draft_probe',
      {},
      CORR,
    );
    expect(envelopeOf(allowed)?.ok).toBe(true);
  });

  it('allows an R2 tool from an R2 capability context (equal rank passes)', async () => {
    const result = await h.core.callTool(
      capabilityAgentCaller(cap('R2')),
      'scripted',
      'write_probe',
      {},
      CORR,
    );
    expect(envelopeOf(result)?.ok).toBe(true);
    expect(h.scriptedCalls.calls).toBe(1);
  });

  it('allows an R0 tool from an R0 context (read path unaffected)', async () => {
    const result = await h.core.callTool(
      capabilityAgentCaller(cap('R0')),
      'scripted',
      'probe',
      {},
      CORR,
    );
    expect(envelopeOf(result)?.ok).toBe(true);
  });

  it('refuses every R2+ tool when there is NO capability context (direct caller)', async () => {
    const result = await h.core.callTool(
      userCaller('probe:write'),
      'scripted',
      'write_probe',
      {},
      {},
    );
    expect(errorOf(result).code).toBe('upstream_auth');
    expect(errorOf(result).message).toContain('no capability context');
    expect(h.scriptedCalls.calls).toBe(0);
  });

  it('allows R0/R1 tools when there is no capability context (Cedar still decides)', async () => {
    const r0 = await h.core.callTool(userCaller('probe:read'), 'scripted', 'probe', {}, {});
    expect(envelopeOf(r0)?.ok).toBe(true);
    const r1 = await h.core.callTool(userCaller('probe:draft'), 'scripted', 'draft_probe', {}, {});
    expect(envelopeOf(r1)?.ok).toBe(true);
  });

  it('audits a risk-class refusal as denied with the refusal fields', async () => {
    await h.core.callTool(capabilityAgentCaller(cap('R0')), 'scripted', 'write_probe', {}, CORR);
    const event = h.audit.at(-1)!;
    expect((event.details as { outcome: string }).outcome).toBe('denied');
    expect(event.details as Record<string, unknown>).toMatchObject({
      refusal: 'risk_class',
      tool_risk: 'R2',
      capability: 'change.step',
      capability_risk: 'R0',
    });
  });

  it('runs AFTER Cedar: a deny is recorded as a policy block, not a risk refusal', async () => {
    h.policy.decision = {
      decision: 'deny',
      bundle_version: '2026.07+deny',
      determining_policies: [],
    };
    const result = await h.core.callTool(
      capabilityAgentCaller(cap('R0')),
      'scripted',
      'write_probe',
      {},
      CORR,
    );
    expect(errorOf(result).message).toContain('Cedar decision: deny');
    const event = h.audit.at(-1)!;
    expect((event.details as { refusal?: string }).refusal).toBeUndefined();
  });

  it('feeds Cedar a capability context (R0 default) and an inactive compensation context', async () => {
    await h.core.callTool(capabilityAgentCaller(cap('R2')), 'scripted', 'write_probe', {}, CORR);
    const ctx = h.policy.requests.at(-1)!.context as {
      capability: { name: string; risk: string };
      compensation: { active: boolean };
    };
    expect(ctx.capability).toEqual({ name: 'change.step', risk: 'R2' });
    expect(ctx.compensation).toEqual({ active: false });
  });

  it('defaults the Cedar capability context to R0 when the token carries no claim', async () => {
    await h.core.callTool(userCaller('probe:read'), 'scripted', 'probe', {}, {});
    const ctx = h.policy.requests.at(-1)!.context as { capability: { name: string; risk: string } };
    expect(ctx.capability).toEqual({ name: '', risk: 'R0' });
  });

  it('marks compensation active only when the claim binds to this correlation task', async () => {
    const compensation = {
      original_step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
      original_capability: 'change.submit',
    };
    // Bound: brokered.task_id === corr.taskId → active.
    await h.core.callTool(
      capabilityAgentCaller(cap('R2'), { compensation }),
      'scripted',
      'write_probe',
      {},
      CORR,
    );
    const bound = h.policy.requests.at(-1)!.context as { compensation: { active: boolean } };
    expect(bound.compensation).toMatchObject({
      active: true,
      original_capability: 'change.submit',
    });

    // Replayed onto a DIFFERENT task → inactive (cannot re-arm elsewhere).
    await h.core.callTool(
      capabilityAgentCaller(cap('R2'), { compensation }),
      'scripted',
      'write_probe',
      {},
      { taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3fff', stepId: RISK_STEP_ID },
    );
    const unbound = h.policy.requests.at(-1)!.context as { compensation: { active: boolean } };
    expect(unbound.compensation).toEqual({ active: false });
  });
});
