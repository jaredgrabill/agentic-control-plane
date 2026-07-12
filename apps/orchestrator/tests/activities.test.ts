import type { AgentCard, AuditEvent, TaskRequest } from '@acp/protocol';
import { plan as planParser } from '@acp/protocol';
import { createLogger, sha256Digest } from '@acp/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_PRICE_BOOK_VERSION, defaultPriceBookPath } from '@acp/cost-meter';
import { createControlActivities } from '../src/activities.js';
import type { ControlActivities, PrincipalSnapshot } from '../src/types.js';

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

const snapshot: PrincipalSnapshot = {
  sub: 'user:jane.doe',
  tenant: 'acme',
  roles: ['tenant-user'],
  scopes: ['task:submit', 'knowledge:search:read'],
  jti: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
  verified_at: '2026-07-11T09:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const verify = vi.fn((token: string) =>
  token === 'subject.jwt'
    ? Promise.resolve({
        sub: 'user:jane.doe',
        tenant: 'acme',
        roles: ['tenant-user'],
        scope: 'task:submit knowledge:search:read',
        jti: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
      })
    : Promise.reject(new Error('token verification failed')),
);

function makeActivities(
  fetchImpl: typeof fetch,
  audit: AuditEvent[] = [],
  priceBookPathOverride?: string,
) {
  return createControlActivities({
    registryUrl: 'http://registry.test',
    policyUrl: 'http://policy.test',
    tokenUrl: 'http://token.test',
    clientId: 'svc-orchestrator',
    clientSecret: 'secret',
    verifier: { verify },
    audit: {
      publish: (e) => {
        audit.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('orchestrator-test'),
    fetchImpl,
    priceBookPath: priceBookPathOverride ?? defaultPriceBookPath(),
  });
}

describe('snapshotPrincipal', () => {
  it('verifies against the gateway audience and snapshots sub, tenant, roles, scopes, jti', async () => {
    verify.mockClear();
    const before = Date.now();
    const snap = await makeActivities(vi.fn()).snapshotPrincipal({
      subjectToken: 'subject.jwt',
      expectedPrincipal: 'user:jane.doe',
      expectedTenant: 'acme',
    });
    expect(verify).toHaveBeenCalledWith('subject.jwt', 'acp:gateway');
    expect(snap.sub).toBe('user:jane.doe');
    expect(snap.tenant).toBe('acme');
    expect(snap.roles).toEqual(['tenant-user']);
    // scopesOf: the space-delimited scope claim becomes the scopes array.
    expect(snap.scopes).toEqual(['task:submit', 'knowledge:search:read']);
    expect(snap.jti).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41');
    expect(Date.parse(snap.verified_at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('refuses an unverifiable token (nonRetryable)', async () => {
    await expect(
      makeActivities(vi.fn() as unknown as typeof fetch).snapshotPrincipal({
        subjectToken: 'forged.jwt',
        expectedPrincipal: 'user:jane.doe',
        expectedTenant: 'acme',
      }),
    ).rejects.toThrow(/intake verification.*verification failed/);
  });

  it('refuses a token that does not match the task attribution', async () => {
    for (const [principal, tenant] of [
      ['user:someone.else', 'acme'],
      ['user:jane.doe', 'globex'],
    ]) {
      await expect(
        makeActivities(vi.fn() as unknown as typeof fetch).snapshotPrincipal({
          subjectToken: 'subject.jwt',
          expectedPrincipal: principal!,
          expectedTenant: tenant!,
        }),
      ).rejects.toThrow(/does not match the task attribution/);
    }
  });
});

describe('planTask', () => {
  const task: TaskRequest = {
    kind: 'task_request',
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    principal: 'user:jane.doe',
    input: { text: 'Why did cloud spend jump last week?', context: { repo: 'acme/payments' } },
  };

  const cloudCard: AgentCard = {
    ...card,
    manifest: {
      ...card.manifest,
      id: 'cloud-agent',
      capabilities: [{ ...card.manifest.capabilities[0], name: 'cloud.cost_analysis' }],
    },
  };
  const codeCard: AgentCard = {
    ...card,
    manifest: {
      ...card.manifest,
      id: 'code-agent',
      capabilities: [{ ...card.manifest.capabilities[0], name: 'code.ci_health' }],
    },
  };

  function planningFetch(agents: AgentCard[]): { impl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const impl = vi.fn((url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      void init;
      if (String(url).endsWith('/v1/token')) return jsonResponse({ access_token: 'svc-token' });
      return jsonResponse({ agents });
    }) as unknown as typeof fetch;
    return { impl, urls };
  }

  it('plans against the active fleet, validates the plan, and digests the exact artifact', async () => {
    const { impl, urls } = planningFetch([cloudCard, codeCard]);
    const { plan, planDigest } = await makeActivities(impl).planTask(task);

    expect(urls[1]).toContain('/v1/agents?state=active');
    expect(plan.planner).toBe('rule-planner@1');
    expect(plan.task_id).toBe(task.task_id);
    expect(plan.tenant).toBe('acme');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].capability).toBe('cloud.cost_analysis');
    expect(plan.steps[1]!.capability).toBe('code.ci_health');
    expect(plan.steps[1]!.input).toEqual({ repo: 'acme/payments' });
    // Independent fan-out: no depends_on between the forensics steps.
    expect(plan.steps[1]!.depends_on).toBeUndefined();

    // Round-trips through the same schema gate an LLM planner must clear.
    expect(planParser.validate(plan)).toBe(true);
    expect(planDigest).toBe(sha256Digest(JSON.stringify(plan)));
  });

  it('honors servability: without the cloud agent the composite never fires', async () => {
    const { impl } = planningFetch([codeCard]);
    const { plan } = await makeActivities(impl).planTask(task);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].capability).toBe('knowledge.answer_with_citations');
  });

  it('throws with the upstream status when the registry listing fails', async () => {
    const impl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ boom: true }, 503),
    ) as unknown as typeof fetch;
    await expect(makeActivities(impl).planTask(task)).rejects.toThrow(
      /registry listing for planning failed: 503/,
    );
  });
});

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
  it('sends the Cedar request with risk and the SNAPSHOT scopes — no verifier call', async () => {
    verify.mockClear();
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
      snapshot,
      requestedScopes: ['knowledge:search:read'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    });
    expect(decision.decision).toBe('allow');
    // ADR-0007: the intake snapshot IS the principal context; the raw
    // subject token is never re-verified here.
    expect(verify).not.toHaveBeenCalled();
    expect(authorizeBody).toMatchObject({
      principal: { type: 'User', id: 'user:jane.doe' },
      action: 'delegate',
      resource: { type: 'Agent', id: 'knowledge-agent' },
      context: {
        risk: 'R0',
        scopes: ['task:submit', 'knowledge:search:read'],
        requested_scopes: ['knowledge:search:read'],
      },
      reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    });
  });

  it('throws when the policy service fails or the token service refuses credentials', async () => {
    const input = {
      principal: 'user:jane.doe',
      tenant: 'acme',
      agent: card,
      capability: 'knowledge.answer_with_citations',
      snapshot,
      requestedScopes: [],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    };
    const policyDown = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ boom: true }, 502),
    ) as unknown as typeof fetch;
    await expect(makeActivities(policyDown).authorizeDelegation(input)).rejects.toThrow(
      /policy service failed: 502/,
    );

    const tokenDown = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'nope' }, 401)),
    ) as unknown as typeof fetch;
    await expect(makeActivities(tokenDown).authorizeDelegation(input)).rejects.toThrow(
      /token service refused client_credentials for acp:policy: 401/,
    );
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
      snapshot,
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

describe('brokerToken', () => {
  it('requests the broker grant with the snapshot subject, actor, and grounds', async () => {
    let url: string | undefined;
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((u: string | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;

    const { token } = await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: card,
      scopes: ['knowledge:search:read'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });
    expect(token).toBe('brokered.jwt');
    expect(url).toBe('http://token.test/v1/token/delegate');
    expect(body).toMatchObject({
      grant_type: 'urn:acp:oauth:grant-type:broker-delegation',
      client_id: 'svc-orchestrator',
      subject: {
        sub: 'user:jane.doe',
        tenant: 'acme',
        roles: ['tenant-user'],
        scopes: ['task:submit', 'knowledge:search:read'],
      },
      audience: 'acp:agent:knowledge-agent',
      scope: 'knowledge:search:read',
      actor: 'agent:knowledge-agent@0.1.0',
      grounds: {
        task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
        subject_jti: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
        verified_at: '2026-07-11T09:00:00Z',
      },
    });
  });

  it('sends scope: "" (present, never omitted) for a toolless agent — empty means empty, not the snapshot', async () => {
    // A manifest with no `tools` is schema-valid; the workflow computes
    // requestedScopes = [] for it. The broker request must carry an explicit
    // empty scope so the token service grants NOTHING — omitting the field
    // would be rejected (and must never default to the whole snapshot).
    const toollessCard: AgentCard = {
      ...card,
      manifest: { ...card.manifest, id: 'toolless-agent' },
    };
    delete (toollessCard.manifest as { tools?: unknown }).tools;
    // Mirrors workflows.ts: requestedScopes from the manifest tool bindings.
    const requestedScopes = (toollessCard.manifest.tools ?? []).flatMap((t) => t.scopes);
    expect(requestedScopes).toEqual([]);

    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;

    await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: toollessCard,
      scopes: requestedScopes,
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });
    expect(body).toBeDefined();
    expect(Object.hasOwn(body!, 'scope')).toBe(true);
    expect(body!.scope).toBe('');
  });

  it('surfaces broker refusals with the upstream status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'stale grounds' }, 403)),
    ) as unknown as typeof fetch;
    await expect(
      makeActivities(fetchImpl).brokerToken({
        snapshot,
        agent: card,
        scopes: [],
        taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      }),
    ).rejects.toThrow(/broker delegation for acp:agent:knowledge-agent failed: 403/);
  });

  it('forwards approval grounds into the broker request when the step was gated', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;

    const approval = {
      approval_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90',
      decision_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f91',
      approver: 'user:approver.ops',
      step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
      capability: 'gov.test_write',
      subject_digest: `sha256:${'a'.repeat(64)}`,
    };
    await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: card,
      scopes: ['knowledge:search:read'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      approval,
    });
    expect(body!.approval).toEqual(approval);
  });

  it('omits approval from the broker request for an ungated step', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;
    await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: card,
      scopes: [],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });
    expect(Object.hasOwn(body!, 'approval')).toBe(false);
  });

  it('forwards compensation grounds into the broker request during an unwind', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;
    const compensation = {
      original_step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
      original_capability: 'gov.test_write',
      approval_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90',
      approver: 'user:approver.ops',
    };
    await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: card,
      scopes: ['gov:test:write'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      compensation,
    });
    expect(body!.compensation).toEqual(compensation);
    expect(Object.hasOwn(body!, 'approval')).toBe(false);
  });
});

describe('authorizeDelegation compensation context', () => {
  it('adds context.compensation when the dispatch is a compensator', async () => {
    let authorizeBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      authorizeBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({
        decision: 'allow',
        bundle_version: 'v',
        determining_policies: ['permit-compensation'],
      });
    }) as unknown as typeof fetch;

    await makeActivities(fetchImpl).authorizeDelegation({
      principal: 'user:jane.doe',
      tenant: 'acme',
      agent: card,
      capability: 'knowledge.answer_with_citations',
      snapshot,
      requestedScopes: [],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      stepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
      compensation: {
        originalStepId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
        originalCapability: 'gov.test_write',
      },
    });
    expect((authorizeBody!.context as Record<string, unknown>).compensation).toEqual({
      active: true,
      original_step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
      original_capability: 'gov.test_write',
    });
  });
});

describe('digestApprovalSubject', () => {
  const subject = {
    approval_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f90',
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
    tenant: 'acme',
    principal: 'user:jane.doe',
    agent_id: 'approval-test-agent',
    agent_version: '0.1.0',
    capability: 'gov.test_write',
    risk: 'R2',
    input: { target: 'record-42', mode: 'apply' },
    requested_scopes: ['gov:test:write'],
    plan: { plan_id: 'p', steps: [] } as unknown as Parameters<
      ControlActivities['digestApprovalSubject']
    >[0]['plan'],
    plan_digest: `sha256:${'0'.repeat(64)}`,
  };

  it('is a sha256 digest, insensitive to key insertion order (stable canonicalization)', async () => {
    const acts = makeActivities(vi.fn());
    const a = await acts.digestApprovalSubject(subject);
    // Same content, different key order and a reordered input object.
    const reordered = {
      plan_digest: subject.plan_digest,
      plan: subject.plan,
      requested_scopes: subject.requested_scopes,
      input: { mode: 'apply', target: 'record-42' },
      risk: subject.risk,
      capability: subject.capability,
      agent_version: subject.agent_version,
      agent_id: subject.agent_id,
      principal: subject.principal,
      tenant: subject.tenant,
      step_id: subject.step_id,
      task_id: subject.task_id,
      approval_id: subject.approval_id,
    };
    const b = await acts.digestApprovalSubject(reordered);
    expect(a.subject_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.subject_digest).toBe(a.subject_digest);
  });

  it('changes when any bound field changes (binds the exact context)', async () => {
    const acts = makeActivities(vi.fn());
    const base = (await acts.digestApprovalSubject(subject)).subject_digest;
    const mutated = (
      await acts.digestApprovalSubject({ ...subject, input: { target: 'record-43' } })
    ).subject_digest;
    expect(mutated).not.toBe(base);
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

describe('getPriceBook', () => {
  const noFetch = (() => {
    throw new Error('getPriceBook must not touch the network');
  }) as unknown as typeof fetch;

  it('loads and resolves the packaged current price book', async () => {
    const book = await makeActivities(noFetch).getPriceBook();
    expect(book.version).toBe(CURRENT_PRICE_BOOK_VERSION);
    // Resolved to integer micro-USD rates: dev-echo@1 input $1/MTok.
    expect(book.models['dev-echo@1']?.inputMicrosPerMTok).toBe(1_000_000);
    expect(book.fallback.inputMicrosPerMTok).toBeGreaterThan(0);
  });

  it('honors the price book path override', async () => {
    const book = await makeActivities(noFetch, [], defaultPriceBookPath()).getPriceBook();
    expect(book.version).toBe(CURRENT_PRICE_BOOK_VERSION);
  });

  it('throws on a malformed or missing price book', async () => {
    await expect(
      makeActivities(noFetch, [], '/no/such/pricebook.json').getPriceBook(),
    ).rejects.toThrow(/could not be read or parsed/);
  });
});
