import type { AgentCard, AuditEvent } from '@acp/protocol';
import { createLogger } from '@acp/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { createControlActivities } from '../src/activities.js';

const card: AgentCard = {
  manifest: {
    id: 'knowledge-agent',
    name: 'Knowledge & Policy Agent',
    owner: 'team-platform',
    description: 'Cited answers.',
    capabilities: [
      {
        name: 'knowledge.answer_with_citations',
        description: 'Answer with citations.',
        risk: 'R0',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        examples: [{ input: {} }, { input: {} }, { input: {} }],
      },
    ],
    tools: [{ server: 'knowledge-store', scopes: ['knowledge:search:read'] }],
  },
  version: '0.1.0',
  lifecycle_state: 'active',
  registered_at: '2026-07-10T08:00:00Z',
  updated_at: '2026-07-10T08:00:00Z',
  card_signature: 'sig',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeActivities(fetchImpl: typeof fetch, audit: AuditEvent[] = []) {
  return createControlActivities({
    registryUrl: 'http://registry.test',
    policyUrl: 'http://policy.test',
    tokenUrl: 'http://token.test',
    clientId: 'svc-orchestrator',
    clientSecret: 'secret',
    verifier: {
      verify: (token: string) =>
        token === 'subject.jwt'
          ? Promise.resolve({
              sub: 'user:jane.doe',
              tenant: 'acme',
              roles: ['tenant-user'],
              scope: 'task:submit knowledge:search:read',
            })
          : Promise.reject(new Error('token verification failed')),
    },
    audit: {
      publish: (e) => {
        audit.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('orchestrator-test'),
    fetchImpl,
  });
}

describe('discoverAgent', () => {
  it('acquires a service token, queries active agents, returns the first match', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith('/v1/token')) return jsonResponse({ access_token: 'svc-token' });
      return jsonResponse({ agents: [card] });
    }) as unknown as typeof fetch;

    const result = await makeActivities(fetchImpl).discoverAgent(
      'knowledge.answer_with_citations',
      'acme',
    );
    expect(result?.manifest.id).toBe('knowledge-agent');
    expect(calls[1]!.url).toContain('capability=knowledge.answer_with_citations');
    expect(calls[1]!.url).toContain('state=active');
    expect((calls[1]!.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer svc-token',
    );
  });

  it('returns null when nothing is routable and throws on registry errors', async () => {
    const empty = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ agents: [] }),
    ) as unknown as typeof fetch;
    expect(await makeActivities(empty).discoverAgent('x.y', 'acme')).toBeNull();

    const broken = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ boom: true }, 500),
    ) as unknown as typeof fetch;
    await expect(makeActivities(broken).discoverAgent('x.y', 'acme')).rejects.toThrow(
      /registry discovery failed: 500/,
    );
  });
});

describe('authorizeDelegation', () => {
  it('sends the Cedar request with risk, scopes, and task attribution', async () => {
    let authorizeBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      authorizeBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({
        decision: 'allow',
        bundle_version: 'v',
        determining_policies: ['allow-r0-delegation'],
      });
    }) as unknown as typeof fetch;

    const decision = await makeActivities(fetchImpl).authorizeDelegation({
      principal: 'user:jane.doe',
      tenant: 'acme',
      agent: card,
      capability: 'knowledge.answer_with_citations',
      subjectToken: 'subject.jwt',
      requestedScopes: ['knowledge:search:read'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(decision.decision).toBe('allow');
    expect(authorizeBody).toMatchObject({
      principal: { type: 'User', id: 'user:jane.doe' },
      action: 'delegate',
      resource: { type: 'Agent', id: 'knowledge-agent' },
      context: {
        risk: 'R0',
        // Cedar rules over the principal's verified scopes; the manifest's
        // requested bindings ride separately for future policies.
        scopes: ['task:submit', 'knowledge:search:read'],
        requested_scopes: ['knowledge:search:read'],
      },
      reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    });
  });

  it('refuses to authorize on an unverifiable subject token', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ access_token: 't' })),
    ) as unknown as typeof fetch;
    await expect(
      makeActivities(fetchImpl).authorizeDelegation({
        principal: 'user:jane.doe',
        tenant: 'acme',
        agent: card,
        capability: 'knowledge.answer_with_citations',
        subjectToken: 'forged.jwt',
        requestedScopes: [],
        taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
        stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
      }),
    ).rejects.toThrow(/verification failed/);
  });

  it('classifies agent principals as Agent and unknown capabilities as R3', async () => {
    let authorizeBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      authorizeBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ decision: 'deny', bundle_version: 'v', determining_policies: [] });
    }) as unknown as typeof fetch;

    await makeActivities(fetchImpl).authorizeDelegation({
      principal: 'agent:composer@1.0.0',
      tenant: 'acme',
      agent: card,
      capability: 'not.declared',
      subjectToken: 'subject.jwt',
      requestedScopes: [],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(authorizeBody).toMatchObject({
      principal: { type: 'Agent' },
      // Undeclared capability defaults to the highest risk — default deny
      // territory, never an accidental allow.
      context: { risk: 'R3' },
    });
  });
});

describe('exchangeToken', () => {
  it('performs RFC 8693 exchange bound to the agent audience and actor', async () => {
    let exchangeBody: Record<string, unknown> | undefined;
    const exchanges: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      exchanges.push(body);
      exchangeBody = body;
      return jsonResponse({
        access_token: body.audience === 'acp:orchestrator' ? 'orch.jwt' : 'delegated',
      });
    }) as unknown as typeof fetch;

    const { token } = await makeActivities(fetchImpl).exchangeToken({
      subjectToken: 'subject.jwt.here',
      agent: card,
      scopes: ['knowledge:search:read'],
    });
    expect(token).toBe('delegated');
    // Two hops: the orchestrator takes custody, then delegates to the agent
    // — the act chain records user → orchestrator → agent.
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({
      audience: 'acp:orchestrator',
      subject_token: 'subject.jwt.here',
    });
    expect(exchanges[0]).not.toHaveProperty('actor');
    expect(exchangeBody).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'orch.jwt',
      audience: 'acp:agent:knowledge-agent',
      actor: 'agent:knowledge-agent@0.1.0',
      scope: 'knowledge:search:read',
    });
  });

  it('surfaces exchange refusals with the upstream status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'nope' }, 401)),
    ) as unknown as typeof fetch;
    await expect(
      makeActivities(fetchImpl).exchangeToken({
        subjectToken: 'expired',
        agent: card,
        scopes: [],
      }),
    ).rejects.toThrow(/token exchange for acp:orchestrator failed: 401/);
  });
});

describe('emitAudit', () => {
  it('validates against the audit-event schema before publishing', async () => {
    const audit: AuditEvent[] = [];
    const acts = makeActivities(vi.fn(), audit);
    await acts.emitAudit({
      event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f50',
      occurred_at: '2026-07-11T09:00:00Z',
      tenant: 'acme',
      event_type: 'step.dispatched',
      actor: { principal: 'svc:orchestrator' },
      action: { name: 'step.dispatched' },
    });
    expect(audit).toHaveLength(1);

    await expect(acts.emitAudit({ event_type: 'not-a-real-event' })).rejects.toThrow(
      /does not conform/,
    );
    expect(audit).toHaveLength(1);
  });
});
