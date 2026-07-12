import type { AgentCard, AuditEvent, TaskRequest } from '@acp/protocol';
import { plan as planParser } from '@acp/protocol';
import { createLogger, sha256Digest } from '@acp/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_PRICE_BOOK_VERSION, defaultPriceBookPath } from '@acp/cost-meter';
import { loadOnlineEvalConfig, type OnlineEvalConfig } from '@acp/online-eval';
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
  onlineEval?: OnlineEvalConfig,
) {
  return createControlActivities({
    registryUrl: 'http://registry.test',
    policyUrl: 'http://policy.test',
    tokenUrl: 'http://token.test',
    auditUrl: 'http://audit.test',
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
    llmGatewayUrl: 'http://llm.test',
    evaluationUrl: 'http://eval.test',
    ...(onlineEval === undefined ? {} : { onlineEval }),
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

describe('resolveRoute', () => {
  const routingFetch = (set: Record<string, unknown>) =>
    vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token') ? jsonResponse({ access_token: 't' }) : jsonResponse(set),
    ) as unknown as typeof fetch;

  it('routes to the active incumbent and computes a deterministic bucket', async () => {
    const acts = makeActivities(routingFetch({ active: card }));
    const r1 = await acts.resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });
    expect(r1?.route).toBe('active');
    expect(r1?.card.manifest.id).toBe('knowledge-agent');
    expect(r1?.bucket).toBeGreaterThanOrEqual(0);
    expect(r1?.bucket).toBeLessThan(100);
    // Same task_id → same bucket (session pinning is a pure function of task_id).
    const r2 = await acts.resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    });
    expect(r2?.bucket).toBe(r1?.bucket);
  });

  it('routes to the canary when the bucket is under the ramp, else the incumbent', async () => {
    const alwaysCanary = await makeActivities(
      routingFetch({ active: card, canary: { card, ramp_percent: 100 } }),
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
    });
    expect(alwaysCanary?.route).toBe('canary');
    expect(alwaysCanary?.rampPercent).toBe(100);

    const neverCanary = await makeActivities(
      routingFetch({ active: card, canary: { card, ramp_percent: 0 } }),
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
    });
    expect(neverCanary?.route).toBe('active');
  });

  it('surfaces a shadow candidate to mirror (shadow soak)', async () => {
    const r = await makeActivities(routingFetch({ active: card, shadow: card })).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
    });
    expect(r?.route).toBe('active');
    expect(r?.shadowCard?.manifest.id).toBe('knowledge-agent');
  });

  it('returns null when nothing is active', async () => {
    const r = await makeActivities(routingFetch({})).resolveRoute({
      capability: 'x.y',
      tenant: 'acme',
      taskId: 't-1',
    });
    expect(r).toBeNull();
  });

  it('activeOnly (probe) routes to the active card even under a 100% canary ramp, never mirrors', async () => {
    const candidate = { ...card, version: '0.2.0' };
    // ramp 100 means EVERY bucket would session-pin to the canary — a probe
    // must still land on the active incumbent, and must not shadow-mirror.
    const r = await makeActivities(
      routingFetch({
        active: card,
        canary: { card: candidate, ramp_percent: 100 },
        shadow: candidate,
      }),
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      activeOnly: true,
    });
    expect(r?.route).toBe('active');
    expect(r?.card.version).toBe(card.version);
    expect(r?.shadowCard).toBeUndefined();

    // No active version → null (a probe never falls back to a candidate).
    const none = await makeActivities(
      routingFetch({ canary: { card: candidate, ramp_percent: 100 } }),
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      activeOnly: true,
    });
    expect(none).toBeNull();
  });

  it('pins to an exact version (compensator) and never mirrors; 404 → null', async () => {
    const pinFetch = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.includes('/versions/0.1.0')) return jsonResponse(card);
      return jsonResponse({ error: 'nope' }, 404);
    }) as unknown as typeof fetch;
    const acts = makeActivities(pinFetch);
    const pinned = await acts.resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      pin: { agentId: 'knowledge-agent', version: '0.1.0' },
    });
    expect(pinned?.route).toBe('pinned');
    expect(pinned?.shadowCard).toBeUndefined();

    const missing = await acts.resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      pin: { agentId: 'knowledge-agent', version: '9.9.9' },
    });
    expect(missing).toBeNull();
  });
});

describe('resolveRoute judge sampling (item 6)', () => {
  const onlineEval = loadOnlineEvalConfig(
    JSON.stringify({
      schema: 'acp-online-eval/v1',
      sample: { default_percent: 0, per_agent: { 'knowledge-agent': 100 } },
      judge: { rubric: 'answer-quality@1', model_class: 'default-tier', min_agreement: 0.85 },
      probes: { interval_s: 2, probe_failure_weight: 5, targets: [] },
      budget: { window_h: 24, min_samples: 5, slo_default: 0.9 },
      drift: {
        input_threshold: 0.5,
        score_drop_threshold: 0.1,
        min_current: 5,
        reference_days: 7,
        cooldown_h: 6,
        severe_probe_failures: 2,
        floor_probe_cycles: 4,
        floor_burn_ratio: 2.0,
      },
    }),
  );
  const routingFetch = (set: Record<string, unknown>) =>
    vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token') ? jsonResponse({ access_token: 't' }) : jsonResponse(set),
    ) as unknown as typeof fetch;

  it('samples a step at the per-agent rate (100% → always judged)', async () => {
    const r = await makeActivities(
      routingFetch({ active: card }),
      [],
      undefined,
      onlineEval,
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      stepId: 's-1',
    });
    expect(r?.judge_sample).toBe(true);
  });

  it('does not sample when there is no stepId or no config', async () => {
    const noStep = await makeActivities(
      routingFetch({ active: card }),
      [],
      undefined,
      onlineEval,
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
    });
    expect(noStep?.judge_sample).toBe(false);
    const noConfig = await makeActivities(routingFetch({ active: card })).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      stepId: 's-1',
    });
    expect(noConfig?.judge_sample).toBe(false);
  });

  it('samples a canary-route step at the per-agent rate', async () => {
    const r = await makeActivities(
      routingFetch({ active: card, canary: { card, ramp_percent: 100 } }),
      [],
      undefined,
      onlineEval,
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      stepId: 's-1',
    });
    expect(r?.route).toBe('canary');
    expect(r?.judge_sample).toBe(true);
  });

  it('boosts the primary to always-judged during a shadow soak', async () => {
    // default_percent is 0, so only the shadow boost can select an unlisted agent.
    const cloudActive: AgentCard = { ...card, manifest: { ...card.manifest, id: 'cloud-agent' } };
    const r = await makeActivities(
      routingFetch({ active: cloudActive, shadow: cloudActive }),
      [],
      undefined,
      onlineEval,
    ).resolveRoute({
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      taskId: 't-1',
      stepId: 's-1',
    });
    expect(r?.judge_sample).toBe(true);
    expect(r?.shadowCard).toBeDefined();
  });
});

describe('scoreWithJudge (item 6)', () => {
  const onlineEval = loadOnlineEvalConfig(
    JSON.stringify({
      schema: 'acp-online-eval/v1',
      sample: { default_percent: 5 },
      judge: { rubric: 'answer-quality@1', model_class: 'default-tier', min_agreement: 0.85 },
      probes: { interval_s: 2, probe_failure_weight: 5, targets: [] },
      budget: { window_h: 24, min_samples: 5, slo_default: 0.9 },
      drift: {
        input_threshold: 0.5,
        score_drop_threshold: 0.1,
        min_current: 5,
        reference_days: 7,
        cooldown_h: 6,
        severe_probe_failures: 2,
        floor_probe_cycles: 4,
        floor_burn_ratio: 2.0,
      },
    }),
  );

  interface Recorded {
    scores: unknown[];
    fetchImpl: typeof fetch;
  }
  function judgeFetch(verdictText: string | { throw: true }): Recorded {
    const scores: unknown[] = [];
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.endsWith('/v1/complete')) {
        if (typeof verdictText === 'object') return Promise.reject(new Error('gateway down'));
        return jsonResponse({
          text: verdictText,
          model_class: 'default-tier',
          model: 'dev-echo@1',
          provider: 'dev',
          model_classes_version: '2026.07',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 1 }],
        });
      }
      if (s.endsWith('/v1/scores')) {
        scores.push(JSON.parse((init?.body as string | undefined) ?? '{}'));
        return jsonResponse({ accepted: true }, 202);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    return { scores, fetchImpl };
  }

  const baseInput = {
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
    tenant: 'acme',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    capability: 'knowledge.answer_with_citations',
    route: 'active' as const,
    input: { question: 'How many vacation days?' },
  };

  it('scores a completed step, POSTs the score, and emits eval.score', async () => {
    const { scores, fetchImpl } = judgeFetch(
      '{"schema":"acp-judge-verdict/v1","score":0.92,"verdict":"pass","reasons":["grounded"]}',
    );
    const audit: AuditEvent[] = [];
    await makeActivities(fetchImpl, audit, undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      output: { text: 'The policy grants 20 days.', citations: [] },
      status: 'completed',
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      source: 'judge',
      route: 'active',
      score: 0.92,
      outcome: 'scored',
    });
    const ev = audit.find((e) => e.event_type === 'eval.score');
    expect(ev?.action.name).toBe('judge:answer-quality@1');
    expect((ev?.details as { outcome: string }).outcome).toBe('scored');
  });

  it('ingests a failed step as a quality observation with NO LLM call', async () => {
    const { scores, fetchImpl } = judgeFetch('should-not-be-called');
    const audit: AuditEvent[] = [];
    await makeActivities(fetchImpl, audit, undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      output: null,
      status: 'failed',
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ passed: false, outcome: 'failed_step', score: null });
  });

  it('does NOT ingest a score when the judge errors (no budget burn), but still audits', async () => {
    const { scores, fetchImpl } = judgeFetch({ throw: true });
    const audit: AuditEvent[] = [];
    await makeActivities(fetchImpl, audit, undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      output: { text: 'answer', citations: [] },
      status: 'completed',
    });
    expect(scores).toHaveLength(0);
    const ev = audit.find((e) => e.event_type === 'eval.score');
    expect((ev?.details as { outcome: string }).outcome).toBe('judge_error');
  });

  it('does NOT ingest on an unparseable verdict but audits the outcome', async () => {
    const { scores, fetchImpl } = judgeFetch('I think the answer is fine, no JSON here.');
    const audit: AuditEvent[] = [];
    await makeActivities(fetchImpl, audit, undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      output: { text: 'answer', citations: [] },
      status: 'completed',
    });
    expect(scores).toHaveLength(0);
    const ev = audit.find((e) => e.event_type === 'eval.score');
    expect((ev?.details as { outcome: string }).outcome).toBe('unparseable_verdict');
  });

  it('renders citations (doc_id + snippet) and stringifies an input with no text field', async () => {
    const { scores, fetchImpl } = judgeFetch(
      '{"schema":"acp-judge-verdict/v1","score":0.8,"verdict":"pass","reasons":[]}',
    );
    await makeActivities(fetchImpl, [], undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      input: { unusual_field: 'no question key here' },
      output: {
        text: 'grounded answer',
        citations: [{ doc_id: 'policy-4', snippet: 'twenty days' }, 'raw-string-citation'],
      },
      status: 'completed',
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ score: 0.8 });
  });

  it('REFUSES to score (uncalibrated) with no LLM call when the model class is uncalibrated', async () => {
    const uncalibratedConfig = loadOnlineEvalConfig(
      JSON.stringify({
        schema: 'acp-online-eval/v1',
        sample: { default_percent: 5 },
        // reasoning-tier has no committed calibration record → the gate refuses.
        judge: { rubric: 'answer-quality@1', model_class: 'reasoning-tier', min_agreement: 0.85 },
        probes: { interval_s: 2, probe_failure_weight: 5, targets: [] },
        budget: { window_h: 24, min_samples: 5, slo_default: 0.9 },
        drift: {
          input_threshold: 0.5,
          score_drop_threshold: 0.1,
          min_current: 5,
          reference_days: 7,
          cooldown_h: 6,
          severe_probe_failures: 2,
          floor_probe_cycles: 4,
          floor_burn_ratio: 2.0,
        },
      }),
    );
    const { scores, fetchImpl } = judgeFetch('should-not-be-called');
    const audit: AuditEvent[] = [];
    await makeActivities(fetchImpl, audit, undefined, uncalibratedConfig).scoreWithJudge({
      ...baseInput,
      output: { text: 'answer', citations: [] },
      status: 'completed',
    });
    expect(scores).toHaveLength(0);
    const ev = audit.find((e) => e.event_type === 'eval.score');
    expect((ev?.details as { outcome: string }).outcome).toBe('uncalibrated');
  });

  it('treats a completed step with null output as a failed observation', async () => {
    const { scores, fetchImpl } = judgeFetch('should-not-be-called');
    await makeActivities(fetchImpl, [], undefined, onlineEval).scoreWithJudge({
      ...baseInput,
      output: null,
      status: 'completed',
    });
    expect(scores[0]).toMatchObject({ passed: false, outcome: 'failed_step' });
  });

  it('falls back to rubric/model defaults when no online-eval config is wired', async () => {
    const { scores, fetchImpl } = judgeFetch(
      '{"schema":"acp-judge-verdict/v1","score":0.88,"verdict":"pass","reasons":[]}',
    );
    // No onlineEval passed → the judge uses answer-quality@1 / default-tier.
    await makeActivities(fetchImpl).scoreWithJudge({
      ...baseInput,
      output: { text: 'answer', citations: [] },
      status: 'completed',
    });
    expect(scores[0]).toMatchObject({ score: 0.88, rubric: 'answer-quality@1' });
  });

  it('never throws — a total failure is swallowed (alarm-continue)', async () => {
    const brokenFetch = vi.fn(() =>
      Promise.reject(new Error('everything is down')),
    ) as unknown as typeof fetch;
    await expect(
      makeActivities(brokenFetch, [], undefined, onlineEval).scoreWithJudge({
        ...baseInput,
        output: { text: 'a', citations: [] },
        status: 'completed',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('probe activities (item 6)', () => {
  const probeAnswer = {
    text: 'The policy grants 20 vacation days.',
    citations: [
      { doc_id: 'policy-4', version: '1', lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    ],
    confidence: 0.9,
  };

  function probeFetch() {
    const scores: unknown[] = [];
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/v1/token'))
        return jsonResponse({ access_token: 't', principal: 'svc:prober' });
      if (s.includes('/v1/agents/knowledge-agent')) return jsonResponse(card);
      if (s.endsWith('/v1/scores')) {
        scores.push(JSON.parse((init?.body as string | undefined) ?? '{}'));
        return jsonResponse({ accepted: true }, 202);
      }
      if (s.includes('/v1/agents?state=active')) return jsonResponse({ agents: [card] });
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    return { scores, fetchImpl };
  }

  it('mints a probe subject token (aud acp:gateway) and echoes the principal', async () => {
    const { fetchImpl } = probeFetch();
    const r = await makeActivities(fetchImpl).mintProbeSubject();
    expect(r.token).toBe('t');
    expect(r.principal).toBe('svc:prober');
  });

  it('defaults the principal to svc:prober when the token response omits it', async () => {
    const fetchImpl = vi.fn(() => jsonResponse({ access_token: 'tok' })) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).mintProbeSubject();
    expect(r.principal).toBe('svc:prober');
  });

  it('throws when the probe subject mint is refused', async () => {
    const fetchImpl = vi.fn(() => jsonResponse({ error: 'nope' }, 403)) as unknown as typeof fetch;
    await expect(makeActivities(fetchImpl).mintProbeSubject()).rejects.toThrow(
      /probe subject mint failed/,
    );
  });

  it('records a passing probe: POSTs source=probe and emits eval.probe_result', async () => {
    const { scores, fetchImpl } = probeFetch();
    const audit: AuditEvent[] = [];
    const r = await makeActivities(fetchImpl, audit).recordProbeResult({
      agent_id: 'knowledge-agent',
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      case_name: 'vacation',
      expect: { must_contain: ['20 vacation'], must_cite_docs: ['policy-4'] },
      weight: 5,
      answer: probeAnswer,
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      duration_ms: 120,
    });
    expect(r.passed).toBe(true);
    expect(scores[0]).toMatchObject({
      source: 'probe',
      route: 'probe',
      passed: true,
      weight: 5,
      agent_version: '0.1.0',
    });
    const ev = audit.find((e) => e.event_type === 'eval.probe_result');
    expect((ev?.details as { passed: boolean; owner: string }).passed).toBe(true);
    expect((ev?.details as { owner: string }).owner).toBe('team-platform');
  });

  it('records a failing probe (answer misses the expectation)', async () => {
    const { scores, fetchImpl } = probeFetch();
    const r = await makeActivities(fetchImpl).recordProbeResult({
      agent_id: 'knowledge-agent',
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      case_name: 'poison',
      expect: { must_contain: ['this text is absent'] },
      weight: 5,
      answer: probeAnswer,
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
      duration_ms: 90,
    });
    expect(r.passed).toBe(false);
    expect(scores[0]).toMatchObject({ passed: false, outcome: 'probe_fail' });
  });

  it('still records (attribution unknown) when the registry lookup and ingest fail', async () => {
    const audit: AuditEvent[] = [];
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      // Registry card lookup fails, and the score ingest fails too.
      return jsonResponse({ error: 'down' }, 503);
    }) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl, audit).recordProbeResult({
      agent_id: 'knowledge-agent',
      capability: 'knowledge.answer_with_citations',
      tenant: 'acme',
      case_name: 'vacation',
      expect: { must_contain: ['20 vacation'] },
      weight: 5,
      answer: probeAnswer,
      task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f42',
      duration_ms: 50,
    });
    // The check still runs; the audit is still emitted with unknown attribution.
    expect(r.passed).toBe(true);
    const ev = audit.find((e) => e.event_type === 'eval.probe_result');
    expect(ev?.artifacts?.agent_version).toBe('unknown');
  });

  it('listProbeTargets returns empty when the registry is unreachable', async () => {
    const fetchImpl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({}, 503),
    ) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).listProbeTargets({ covered: [] });
    expect(r.uncovered).toEqual([]);
  });

  it('warns about active agents without probe coverage', async () => {
    const { fetchImpl } = probeFetch();
    const uncovered = await makeActivities(fetchImpl).listProbeTargets({ covered: [] });
    expect(uncovered.uncovered).toContain('knowledge-agent');
    const none = await makeActivities(fetchImpl).listProbeTargets({ covered: ['knowledge-agent'] });
    expect(none.uncovered).toHaveLength(0);
  });
});

describe('checkQualityFreeze (item 6)', () => {
  it('reads the eval quality endpoint and returns frozen when the budget is frozen', async () => {
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      return jsonResponse({ frozen: true, budget: { burn_ratio: 1.4, state: 'exhausted' } });
    }) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).checkQualityFreeze('knowledge-agent');
    expect(r.frozen).toBe(true);
    expect(r.reason).toBe('change_freeze');
    expect(r.burn_ratio).toBe(1.4);
  });

  it('returns not-frozen when the budget is healthy', async () => {
    const fetchImpl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ frozen: false, budget: { burn_ratio: 0, state: 'ok' } }),
    ) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).checkQualityFreeze('knowledge-agent');
    expect(r.frozen).toBe(false);
  });

  it('FAILS CLOSED (frozen) when the eval service is unreachable', async () => {
    const fetchImpl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : Promise.reject(new Error('eval down')),
    ) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).checkQualityFreeze('knowledge-agent');
    expect(r.frozen).toBe(true);
    expect(r.reason).toBe('freeze_check_unavailable');
  });

  it('reports frozen without a burn_ratio when the budget omits it', async () => {
    const fetchImpl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({ frozen: true }),
    ) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).checkQualityFreeze('knowledge-agent');
    expect(r.frozen).toBe(true);
    expect(r.burn_ratio).toBeUndefined();
  });

  it('FAILS CLOSED on a non-2xx from the eval service', async () => {
    const fetchImpl = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({}, 500),
    ) as unknown as typeof fetch;
    const r = await makeActivities(fetchImpl).checkQualityFreeze('knowledge-agent');
    expect(r.frozen).toBe(true);
    expect(r.reason).toBe('freeze_check_unavailable');
  });
});

describe('evaluateGate quality fold (item 6)', () => {
  it('folds paired judged quality from the scores store into the shadow gate report', async () => {
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.includes('/v1/events')) return jsonResponse({ events: [] });
      if (s.includes('/v1/scores/aggregate')) {
        // Candidate (shadow route) low, incumbent (active) high → breach.
        const route = new URL(s).searchParams.get('route');
        return route === 'shadow'
          ? jsonResponse({ mean: 0.6, n: 5 })
          : jsonResponse({ mean: 0.95, n: 20 });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const report = await makeActivities(fetchImpl).evaluateGate({
      kind: 'shadow',
      tenant: 'acme',
      agentId: 'knowledge-agent',
      since: '2026-07-11T10:00:00Z',
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: {
        max_success_delta: 0.05,
        max_p95_ratio: 1.5,
        max_cost_ratio: 1.25,
        min_shadow_completion: 0.9,
        min_shadow_samples: 5,
        max_quality_delta: 0.1,
        min_quality_samples: 5,
      },
    });
    // No audit events → insufficient_data, but quality fetch still ran (fold is
    // omitted only on the report path; the request path is exercised).
    expect(report.verdict).toBe('insufficient_data');
  });

  it('omits the quality fold entirely when no agentId is supplied (canary)', async () => {
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.includes('/v1/events')) return jsonResponse({ events: [] });
      // /v1/scores/aggregate must NOT be called without an agentId.
      return jsonResponse({ mean: 0.1, n: 99 });
    }) as unknown as typeof fetch;
    const report = await makeActivities(fetchImpl).evaluateGate({
      kind: 'canary',
      tenant: 'acme',
      since: '2026-07-11T10:00:00Z',
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: {
        max_success_delta: 0.05,
        max_p95_ratio: 1.5,
        max_cost_ratio: 1.25,
        min_shadow_completion: 0.9,
        min_shadow_samples: 5,
        max_quality_delta: 0.1,
        min_quality_samples: 5,
      },
    });
    expect(report.metrics.quality).toBeUndefined();
  });
});

describe('digestValue', () => {
  it('is a stable sha256 over the canonical value (key-order independent)', async () => {
    const acts = makeActivities(vi.fn());
    const a = await acts.digestValue({ b: 1, a: 2 });
    const b = await acts.digestValue({ a: 2, b: 1 });
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
  });
});

describe('deployment activities', () => {
  const baseline = { suite: { digest: `sha256:${'1'.repeat(64)}` } };
  const candidate = (over: Partial<AgentCard> = {}): AgentCard => ({
    ...card,
    version: '0.2.0',
    lifecycle_state: 'registered',
    eval_baseline: baseline as never,
    ...over,
  });

  it('beginDeployment validates the candidate and resolves the incumbent + baseline note', async () => {
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.includes('/versions/0.2.0')) return jsonResponse(candidate());
      if (s.includes('state=active'))
        return jsonResponse({ agents: [{ ...card, eval_baseline: baseline }] });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const pre = await makeActivities(fetchImpl).beginDeployment({
      agentId: 'knowledge-agent',
      candidateVersion: '0.2.0',
    });
    expect(pre.incumbentVersion).toBe('0.1.0');
    expect(pre.requiresApproval).toBe(false); // R0 capability
    expect(pre.baselineNote).toBe('comparable_suite');
    expect(pre.capabilities).toEqual(['knowledge.answer_with_citations']);
  });

  it('beginDeployment refuses a non-registered candidate or a missing baseline', async () => {
    const active = vi.fn((url: string | URL) =>
      String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse(candidate({ lifecycle_state: 'active' })),
    ) as unknown as typeof fetch;
    await expect(
      makeActivities(active).beginDeployment({
        agentId: 'knowledge-agent',
        candidateVersion: '0.2.0',
      }),
    ).rejects.toThrow(/not registered/);

    const noBaseline = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      const { eval_baseline: _b, ...rest } = candidate();
      return jsonResponse(rest);
    }) as unknown as typeof fetch;
    await expect(
      makeActivities(noBaseline).beginDeployment({
        agentId: 'knowledge-agent',
        candidateVersion: '0.2.0',
      }),
    ).rejects.toThrow(/no eval_baseline/);
  });

  it('beginDeployment flags requiresApproval for an R2-capable candidate', async () => {
    const r0cap = card.manifest.capabilities[0];
    const r2 = candidate({
      manifest: {
        ...card.manifest,
        capabilities: [{ ...r0cap, risk: 'R2' }],
      },
    });
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      if (s.includes('/versions/')) return jsonResponse(r2);
      return jsonResponse({ agents: [] });
    }) as unknown as typeof fetch;
    const pre = await makeActivities(fetchImpl).beginDeployment({
      agentId: 'knowledge-agent',
      candidateVersion: '0.2.0',
    });
    expect(pre.requiresApproval).toBe(true);
    expect(pre.incumbentVersion).toBeUndefined(); // no active agent
  });

  it('deployTransition posts the versioned state with the registry:deploy token', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      if (String(url).endsWith('/v1/token')) {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const scope = (JSON.parse(raw) as { scope?: string }).scope;
        expect(scope).toBe('registry:deploy');
        return jsonResponse({ access_token: 't' });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await makeActivities(fetchImpl).deployTransition({
      agentId: 'knowledge-agent',
      version: '0.2.0',
      state: 'canary',
      rampPercent: 25,
      reason: 'ramp',
    });
    const post = calls.at(-1)!;
    expect(post.url).toContain('/versions/0.2.0/state');
    expect(JSON.parse(post.body as string)).toMatchObject({ state: 'canary', ramp_percent: 25 });
  });

  it('promoteVersion posts to /promote', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((url: string | URL) => {
      calls.push(String(url));
      return String(url).endsWith('/v1/token')
        ? jsonResponse({ access_token: 't' })
        : jsonResponse({});
    }) as unknown as typeof fetch;
    await makeActivities(fetchImpl).promoteVersion({
      agentId: 'knowledge-agent',
      version: '0.2.0',
    });
    expect(calls.at(-1)).toContain('/v1/agents/knowledge-agent/promote');
  });

  it('evaluateGate pages the audit window and runs the evaluator (canary)', async () => {
    const events = [
      {
        event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f60',
        occurred_at: '2026-07-11T10:00:00Z',
        tenant: 'acme',
        event_type: 'step.completed',
        actor: { principal: 'svc:orchestrator' },
        action: { name: 'step.completed' },
        reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
        artifacts: { agent_version: '0.2.0' },
        details: { status: 'completed', duration_ms: 100 },
      },
    ];
    const fetchImpl = vi.fn((url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/v1/token')) return jsonResponse({ access_token: 't' });
      expect(s).toContain('/v1/events');
      expect(s).toContain('since=');
      return jsonResponse({ events });
    }) as unknown as typeof fetch;
    const report = await makeActivities(fetchImpl).evaluateGate({
      kind: 'canary',
      tenant: 'acme',
      since: '2026-07-11T09:59:00Z',
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: {
        max_success_delta: 0.05,
        max_p95_ratio: 1.5,
        max_cost_ratio: 1.25,
        min_shadow_completion: 0.9,
        min_shadow_samples: 2,
        max_quality_delta: 0.1,
        min_quality_samples: 2,
      },
    });
    expect(report.samples.candidate).toBe(1);
    expect(report.verdict).toBe('pass');
  });

  it('now returns an ISO timestamp', async () => {
    const { iso } = await makeActivities(vi.fn()).now();
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
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

  it('forwards capability grounds (name + risk) into the broker request', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn((_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonResponse({ access_token: 'brokered.jwt' });
    }) as unknown as typeof fetch;
    await makeActivities(fetchImpl).brokerToken({
      snapshot,
      agent: card,
      scopes: ['itsm:change:submit'],
      taskId: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      capability: { name: 'change.submit', risk: 'R2' },
    });
    expect(body!.capability).toEqual({ name: 'change.submit', risk: 'R2' });
  });

  it('omits capability when the mint carries no capability grounds', async () => {
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
    expect(Object.hasOwn(body!, 'capability')).toBe(false);
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
    plan: { plan_id: 'p', steps: [] } as unknown as NonNullable<
      Parameters<ControlActivities['digestApprovalSubject']>[0]['plan']
    >,
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

describe('checkKillSwitch (compensation-exemption matrix)', () => {
  const flags = {
    fleet: false,
    agent: new Set<string>(),
    capability: new Set<string>(),
    // Executing risks blocked by an active covering flag (test computes coverage).
    risk: new Set<string>(),
  };
  const killSwitch = {
    fleetHalt: () => (flags.fleet ? { reason: 'fleet down' } : undefined),
    agentSuspension: (id: string) => (flags.agent.has(id) ? { reason: 'agent bad' } : undefined),
    capabilitySuspension: (n: string) =>
      flags.capability.has(n) ? { reason: 'cap bad' } : undefined,
    riskClassSuspension: (r: string) => (flags.risk.has(r) ? { reason: 'risk bad' } : undefined),
  };
  function acts() {
    return createControlActivities({
      registryUrl: 'http://r.test',
      policyUrl: 'http://p.test',
      tokenUrl: 'http://t.test',
      auditUrl: 'http://a.test',
      clientId: 'svc-orchestrator',
      clientSecret: 'secret',
      verifier: { verify },
      audit: { publish: () => Promise.resolve() },
      logger: createLogger('orchestrator-test'),
      fetchImpl: vi.fn(),
      priceBookPath: defaultPriceBookPath(),
      killSwitch,
    });
  }
  const reset = () => {
    flags.fleet = false;
    flags.agent.clear();
    flags.capability.clear();
    flags.risk.clear();
  };
  const check = (over: Partial<Parameters<ControlActivities['checkKillSwitch']>[0]> = {}) =>
    acts().checkKillSwitch({
      capability: 'change.submit',
      risk: 'R2',
      agentId: 'change-agent',
      compensation: false,
      ...over,
    });

  it('answers not-halted when no flag is set', async () => {
    reset();
    expect(await check()).toEqual({ halted: false });
  });

  it('blocks fleet + risk for a NORMAL step but EXEMPTs a compensator', async () => {
    reset();
    flags.fleet = true;
    expect((await check()).halted).toBe(true);
    expect((await check({ compensation: true })).halted).toBe(false);

    reset();
    flags.risk.add('R2');
    expect(await check()).toMatchObject({ halted: true, tier: 'risk', target: 'R2' });
    expect((await check({ compensation: true })).halted).toBe(false);
  });

  it('blocks named-capability + agent for BOTH normal and compensator', async () => {
    reset();
    flags.capability.add('change.submit');
    expect(await check()).toMatchObject({ halted: true, tier: 'capability' });
    expect(await check({ compensation: true })).toMatchObject({ halted: true, tier: 'capability' });

    reset();
    flags.agent.add('change-agent');
    expect(await check()).toMatchObject({ halted: true, tier: 'agent' });
    expect(await check({ compensation: true })).toMatchObject({ halted: true, tier: 'agent' });
  });

  it('answers not-halted when no killSwitch is wired (unit/no-op default)', async () => {
    const noKs = createControlActivities({
      registryUrl: 'http://r.test',
      policyUrl: 'http://p.test',
      tokenUrl: 'http://t.test',
      clientId: 'svc-orchestrator',
      clientSecret: 'secret',
      verifier: { verify },
      audit: { publish: () => Promise.resolve() },
      logger: createLogger('orchestrator-test'),
      fetchImpl: vi.fn(),
      priceBookPath: defaultPriceBookPath(),
    });
    expect(
      await noKs.checkKillSwitch({
        capability: 'change.submit',
        risk: 'R2',
        agentId: 'change-agent',
        compensation: false,
      }),
    ).toEqual({ halted: false });
  });
});
