import { HashEmbedder } from '@acp/embedding';
import { loadOnlineEvalConfig, type ScoreIngest } from '@acp/online-eval';
import type { JwtVerifier, Logger, PlatformClaims } from '@acp/service-kit';
import type { AuditEvent } from '@acp/protocol';
import { describe, expect, it, vi } from 'vitest';
import { buildEvalService, type AgentMeta, type LadderActions } from '../src/service/app.js';
import type { BudgetObservation } from '@acp/online-eval';
import type { DriftWindows, PgScoresStore, QualityState, SourceSli } from '../src/service/store.js';

const CONFIG = loadOnlineEvalConfig(
  JSON.stringify({
    schema: 'acp-online-eval/v1',
    sample: { default_percent: 100 },
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

/** An in-memory scores store exercising the enforcement brain without Postgres. */
class MemStore {
  rows: ScoreIngest[] = [];
  /** Keyed `${tenant}/${agent_id}` — mirrors the (tenant, agent_id) PK. */
  state = new Map<string, QualityState>();

  insert(ingest: ScoreIngest): Promise<boolean> {
    if (this.rows.some((r) => r.id === ingest.id)) return Promise.resolve(false);
    this.rows.push(ingest);
    return Promise.resolve(true);
  }
  budgetObservations(tenant: string, agentId: string): Promise<BudgetObservation[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenant === tenant && r.agent_id === agentId)
        .map((r) => ({
          source: r.source,
          route: r.route,
          score: r.score,
          passed: r.passed,
          weight: r.weight,
        })),
    );
  }
  sli(): Promise<SourceSli> {
    return Promise.resolve({
      judge_mean: null,
      probe_pass_rate: null,
      human_pass_rate: null,
      n_by_source: { judge: 0, probe: 0, human: 0 },
    });
  }
  windowJudgeMean(tenant: string, agentId: string): Promise<number | null> {
    const j = this.rows.filter(
      (r) =>
        r.tenant === tenant &&
        r.agent_id === agentId &&
        r.source === 'judge' &&
        (r.route === 'active' || r.route === 'canary'),
    );
    if (j.length === 0) return Promise.resolve(null);
    return Promise.resolve(j.reduce((s, r) => s + (r.score ?? 0), 0) / j.length);
  }
  driftWindows(): Promise<DriftWindows> {
    return Promise.resolve({
      current: { vectors: [], scores: [] },
      reference: { vectors: [], scores: [] },
    });
  }
  versionRouteQuality(): Promise<{ mean: number | null; n: number }> {
    return Promise.resolve({ mean: null, n: 0 });
  }
  getQualityState(tenant: string, agentId: string): Promise<QualityState | undefined> {
    return Promise.resolve(this.state.get(`${tenant}/${agentId}`));
  }
  upsertQualityState(s: QualityState): Promise<void> {
    this.state.set(`${s.tenant}/${s.agent_id}`, s);
    return Promise.resolve();
  }
}

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function harness(overrides?: { meta?: AgentMeta; claims?: Partial<PlatformClaims> }) {
  const store = new MemStore();
  const audits: AuditEvent[] = [];
  const abortDeployment = vi.fn(() => Promise.resolve());
  const suspendAgent = vi.fn(() => Promise.resolve());
  const actions: LadderActions = { abortDeployment, suspendAgent };
  const verifier = {
    verify: (_t: string, _a: string): Promise<PlatformClaims> =>
      Promise.resolve({
        sub: 'svc:orchestrator',
        tenant: 'platform',
        roles: ['platform'],
        scope: 'eval:write eval:read',
        ...overrides?.claims,
      }),
  } as unknown as JwtVerifier;
  const app = buildEvalService({
    verifier,
    store: store as unknown as PgScoresStore,
    config: CONFIG,
    audit: {
      publish: (e: AuditEvent) => {
        audits.push(e);
        return Promise.resolve();
      },
    },
    actions,
    agentMeta: () => Promise.resolve(overrides?.meta ?? { slo: 0.9, owner: 'team:knowledge' }),
    logger,
  });
  return { app, store, audits, abortDeployment, suspendAgent };
}

const AUTH = { authorization: 'Bearer t' };

/** The audit-event `details` is a schema-open object; read it typed in tests. */
const detailsOf = (e: AuditEvent | undefined): Record<string, unknown> => e?.details ?? {};

function probeFail(id: string): ScoreIngest {
  return {
    id,
    agent_id: 'poison-agent',
    agent_version: '0.1.0',
    capability: 'knowledge.search',
    tenant: 'acme',
    source: 'probe',
    route: 'probe',
    score: null,
    passed: false,
    weight: 5,
  };
}

describe('eval service auth', () => {
  it('rejects a missing token', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'POST', url: '/v1/scores', payload: probeFail('a') });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed ingest with 400', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/scores',
      headers: AUTH,
      payload: { id: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('scores ingest', () => {
  it('accepts and deduplicates by id', async () => {
    const { app, store } = harness();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/scores',
      headers: AUTH,
      payload: probeFail('dup'),
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ deduplicated: false });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/scores',
      headers: AUTH,
      payload: probeFail('dup'),
    });
    expect(second.json()).toMatchObject({ deduplicated: true });
    expect(store.rows).toHaveLength(1);
  });
});

describe('degradation ladder over ingests', () => {
  it('climbs warning→severe(abort)→floor(suspend+page) as probe failures accrue', async () => {
    const { app, audits, abortDeployment, suspendAgent } = harness();
    const inject = (id: string) =>
      app.inject({ method: 'POST', url: '/v1/scores', headers: AUTH, payload: probeFail(id) });

    // 1 failure: measurable (weight 5 >= min_samples 5), burn very high →
    // exhausted budget, but probe streak 1 < severe threshold 2.
    await inject('p1');
    // 2 failures → severe rung → abort called once.
    await inject('p2');
    expect(abortDeployment).toHaveBeenCalledTimes(1);
    // 3 failures → still severe, no re-abort.
    await inject('p3');
    expect(abortDeployment).toHaveBeenCalledTimes(1);
    // 4 failures → floor → suspend + page.
    await inject('p4');
    expect(suspendAgent).toHaveBeenCalledTimes(1);

    const pageEvent = audits.find(
      (e) => e.event_type === 'eval.budget_state_changed' && detailsOf(e).to === 'floor',
    );
    expect(detailsOf(pageEvent).page).toBe(true);
    expect(detailsOf(pageEvent).owner).toBe('team:knowledge');
  });

  it('judge-burn alone freezes (severe) but NEVER auto-suspends — cross-tenant DoS guard', async () => {
    // SECURITY: judge samples score attacker-chosen inputs to a SHARED agent.
    // Ten bad judged samples (score 0.1, weight 1 each) drive burn_ratio to 10 —
    // far above floor_burn_ratio (2.0) — with ZERO probe failures. The floor
    // (irreversible, coarse auto-suspend) must NOT be reached from judge-burn.
    const { app, audits, abortDeployment, suspendAgent } = harness();
    const judgeBad = (id: string): ScoreIngest => ({
      id,
      agent_id: 'poison-agent',
      agent_version: '0.1.0',
      capability: 'knowledge.search',
      tenant: 'attacker-tenant',
      source: 'judge',
      route: 'active',
      score: 0.1,
      passed: null,
      weight: 1,
    });
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/scores',
        headers: AUTH,
        payload: judgeBad(`j${i}`),
      });
    }
    // Reversible severe reached (deployment-abort), but no suspend and no page.
    expect(suspendAgent).not.toHaveBeenCalled();
    expect(abortDeployment).toHaveBeenCalledTimes(1);
    const floorPage = audits.find(
      (e) => e.event_type === 'eval.budget_state_changed' && detailsOf(e).to === 'floor',
    );
    expect(floorPage).toBeUndefined();
    const severe = audits.find(
      (e) => e.event_type === 'eval.budget_state_changed' && detailsOf(e).to === 'severe',
    );
    expect(detailsOf(severe).page).toBe(false);
  });

  it('is fail-open below min_samples (a budget that cannot measure does not freeze)', async () => {
    const { app, audits } = harness();
    // One judged bad sample, weight 1 < min_samples 5 → not measurable → ok.
    await app.inject({
      method: 'POST',
      url: '/v1/scores',
      headers: AUTH,
      payload: {
        id: 'j1',
        agent_id: 'poison-agent',
        agent_version: '0.1.0',
        capability: 'knowledge.search',
        tenant: 'acme',
        source: 'judge',
        route: 'active',
        score: 0.1,
        passed: null,
        weight: 1,
      } satisfies ScoreIngest,
    });
    expect(audits.find((e) => e.event_type === 'eval.budget_state_changed')).toBeUndefined();
  });
});

describe('quality endpoint', () => {
  it('returns the SLI + budget + freeze view for the named tenant', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality?tenant=acme',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body: { agent_id: string; window_h: number; budget: unknown; frozen: unknown } =
      res.json();
    expect(body).toMatchObject({ agent_id: 'poison-agent', tenant: 'acme', window_h: 24 });
    expect(body.budget).toHaveProperty('state');
    expect(body).toHaveProperty('frozen');
  });

  it('requires the tenant param on both read surfaces (400 when missing)', async () => {
    const { app } = harness();
    const quality = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality',
      headers: AUTH,
    });
    expect(quality.statusCode).toBe(400);
    const aggregate = await app.inject({
      method: 'GET',
      url: '/v1/scores/aggregate?agent_id=k&agent_version=0.2.0&route=shadow',
      headers: AUTH,
    });
    expect(aggregate.statusCode).toBe(400);
  });

  it('400s a malformed tenant on the budget route, not 500 (B5)', async () => {
    // A platform caller naming a malformed tenant (e.g. "foo.bar") must get a
    // client-error 400, never a 500 from budgetStatus's internal assertTenantId.
    const { app } = harness();
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/tenants/foo.bar/budget',
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
    // A well-formed tenant passes the shape gate (here it 404s only because no
    // budget ledger is wired into this harness) — proving 400 is the format,
    // not a missing dependency.
    const wellFormed = await app.inject({
      method: 'GET',
      url: '/v1/tenants/globex/budget',
      headers: AUTH,
    });
    expect(wellFormed.statusCode).toBe(404);
  });

  it('binds the tenant param to the verified claims for non-platform callers', async () => {
    // A tenant-scoped caller may read ONLY its own tenant's quality.
    const { app } = harness({
      claims: { sub: 'user:eve', tenant: 'globex', roles: ['tenant-user'] },
    });
    const foreign = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality?tenant=acme',
      headers: AUTH,
    });
    expect(foreign.statusCode).toBe(403);
    const foreignAgg = await app.inject({
      method: 'GET',
      url: '/v1/scores/aggregate?tenant=acme&agent_id=k&agent_version=0.2.0&route=shadow',
      headers: AUTH,
    });
    expect(foreignAgg.statusCode).toBe(403);

    const own = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality?tenant=globex',
      headers: AUTH,
    });
    expect(own.statusCode).toBe(200);
  });

  it('serves the version+route aggregate for the deployment gate', async () => {
    const { app } = harness();
    void new HashEmbedder(); // embedding pkg is wired
    const res = await app.inject({
      method: 'GET',
      url: '/v1/scores/aggregate?tenant=acme&agent_id=k&agent_version=0.2.0&route=shadow',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mean: null, n: 0 });
  });

  it('rejects an aggregate query missing params with 400', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/scores/aggregate?tenant=acme&agent_id=k',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("quality state is tenant-isolated: one tenant's burn never freezes another", async () => {
    // Drive acme's poison-agent to an exhausted budget via weighted probe
    // failures, then read the SAME agent under globex: level ok, not frozen.
    const { app, store } = harness();
    for (const id of ['t1', 't2']) {
      await app.inject({
        method: 'POST',
        url: '/v1/scores',
        headers: AUTH,
        payload: probeFail(id),
      });
    }
    expect(store.state.get('acme/poison-agent')?.level).not.toBe('ok');
    expect(store.state.get('globex/poison-agent')).toBeUndefined();

    const globexView = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality?tenant=globex',
      headers: AUTH,
    });
    expect(globexView.statusCode).toBe(200);
    expect(globexView.json()).toMatchObject({ level: 'ok', frozen: false });

    const acmeView = await app.inject({
      method: 'GET',
      url: '/v1/agents/poison-agent/quality?tenant=acme',
      headers: AUTH,
    });
    expect(acmeView.json<{ frozen: boolean }>().frozen).toBe(true);
  });
});

describe('drift alerting', () => {
  it('emits eval.drift_detected on the joint condition from a judged embedded sample', async () => {
    const emb = new HashEmbedder();
    const store = new MemStore();
    // Reference: quality high on one topic; current: inputs shifted AND scores fell.
    store.driftWindows = () =>
      Promise.resolve({
        current: {
          vectors: Array.from({ length: 6 }, () =>
            emb.embed('vacation policy holiday leave days off'),
          ),
          scores: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        },
        reference: {
          vectors: Array.from({ length: 6 }, () =>
            emb.embed('cloud cost report finance quarterly'),
          ),
          scores: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
        },
      });
    const audits: AuditEvent[] = [];
    const verifier = {
      verify: (): Promise<PlatformClaims> =>
        Promise.resolve({
          sub: 'svc',
          tenant: 'platform',
          roles: ['platform'],
          scope: 'eval:write',
        } as PlatformClaims),
    } as unknown as JwtVerifier;
    const app = buildEvalService({
      verifier,
      store: store as unknown as PgScoresStore,
      config: CONFIG,
      audit: {
        publish: (e) => {
          audits.push(e);
          return Promise.resolve();
        },
      },
      actions: { abortDeployment: () => Promise.resolve(), suspendAgent: () => Promise.resolve() },
      agentMeta: () => Promise.resolve({ slo: 0.9, owner: 'team:knowledge' }),
      logger,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/scores',
      headers: AUTH,
      payload: {
        id: 'jd1',
        agent_id: 'drift-agent',
        agent_version: '0.1.0',
        capability: 'knowledge.search',
        tenant: 'acme',
        source: 'judge',
        route: 'active',
        score: 0.5,
        passed: null,
        weight: 1,
        input_embedding: emb.embed('vacation policy holiday leave days off'),
      } satisfies ScoreIngest,
    });
    const drift = audits.find((e) => e.event_type === 'eval.drift_detected');
    expect(drift).toBeDefined();
    expect(detailsOf(drift).capability).toBe('knowledge.search');
  });
});
