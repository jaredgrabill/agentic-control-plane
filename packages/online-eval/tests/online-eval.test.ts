import { EMBEDDING_DIM, HashEmbedder } from '@acp/embedding';
import { describe, expect, it } from 'vitest';
import {
  computeBudget,
  computeDrift,
  computeLadderLevel,
  decideJudgeSample,
  driftAlertDue,
  loadOnlineEvalConfig,
  parseScoreIngest,
  planLadderTransition,
  type BudgetObservation,
  type LadderSignals,
  type OnlineEvalConfig,
} from '../src/index.js';

const CONFIG_JSON = JSON.stringify({
  schema: 'acp-online-eval/v1',
  sample: { default_percent: 5, per_agent: { 'knowledge-agent': 100 } },
  judge: { rubric: 'answer-quality@1', model_class: 'default-tier', min_agreement: 0.85 },
  probes: {
    interval_s: 300,
    probe_failure_weight: 5,
    targets: [
      {
        agent_id: 'knowledge-agent',
        tenant: 'acme',
        capability: 'knowledge.search',
        cases: [{ name: 'c1', input: 'q', expect: { must_contain: ['x'] } }],
      },
    ],
  },
  budget: { window_h: 24, min_samples: 10, slo_default: 0.9 },
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
});

const cfg: OnlineEvalConfig = loadOnlineEvalConfig(CONFIG_JSON);

describe('config loader', () => {
  it('parses a valid config', () => {
    expect(cfg.sample.default_percent).toBe(5);
    expect(cfg.probes.targets[0]?.capability).toBe('knowledge.search');
  });
  it('rejects an unknown key', () => {
    const bad = { ...(JSON.parse(CONFIG_JSON) as Record<string, unknown>), bogus: 1 };
    expect(() => loadOnlineEvalConfig(JSON.stringify(bad))).toThrow(/invalid online-eval config/);
  });
  it('rejects non-JSON', () => {
    expect(() => loadOnlineEvalConfig('{not json')).toThrow(/not valid JSON/);
  });
});

describe('sampling', () => {
  it('is deterministic per (task, step)', () => {
    const a = decideJudgeSample(cfg.sample, { taskId: 't', stepId: 's', agentId: 'other-agent' });
    const b = decideJudgeSample(cfg.sample, { taskId: 't', stepId: 's', agentId: 'other-agent' });
    expect(a.selected).toBe(b.selected);
  });
  it('per-agent override at 100 always selects', () => {
    const d = decideJudgeSample(cfg.sample, {
      taskId: 't',
      stepId: 's',
      agentId: 'knowledge-agent',
    });
    expect(d.selected).toBe(true);
    expect(d.percent).toBe(100);
  });
  it('a 0 percent never selects', () => {
    const zero = { default_percent: 0 };
    expect(decideJudgeSample(zero, { taskId: 't', stepId: 's', agentId: 'x' }).selected).toBe(
      false,
    );
  });
  it('shadow boost forces selection regardless of rate', () => {
    const zero = { default_percent: 0 };
    const d = decideJudgeSample(zero, { taskId: 't', stepId: 's', agentId: 'x', boost: true });
    expect(d.selected).toBe(true);
    expect(d.percent).toBe(100);
  });
  it('spreads roughly at the configured rate', () => {
    let hits = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (
        decideJudgeSample({ default_percent: 5 }, { taskId: `t${i}`, stepId: 's', agentId: 'x' })
          .selected
      ) {
        hits++;
      }
    }
    expect(hits / n).toBeGreaterThan(0.02);
    expect(hits / n).toBeLessThan(0.09);
  });
});

describe('scores wire', () => {
  it('accepts a judged ingest', () => {
    const ing = parseScoreIngest({
      id: 'a',
      agent_id: 'knowledge-agent',
      agent_version: '0.1.0',
      capability: 'knowledge.search',
      tenant: 'acme',
      source: 'judge',
      route: 'active',
      score: 0.9,
      passed: null,
      weight: 1,
    });
    expect(ing.score).toBe(0.9);
  });
  it('rejects an out-of-range score', () => {
    expect(() =>
      parseScoreIngest({
        id: 'a',
        agent_id: 'k',
        agent_version: '0.1.0',
        capability: 'c',
        tenant: 'acme',
        source: 'judge',
        route: 'active',
        score: 1.5,
        passed: null,
        weight: 1,
      }),
    ).toThrow(/invalid score ingest/);
  });
});

describe('error budget', () => {
  const obs = (n: number, bad: number, weight = 1): BudgetObservation[] =>
    Array.from({ length: n }, (_, i) => ({
      source: 'judge' as const,
      route: 'active' as const,
      score: i < bad ? 0.2 : 0.95,
      passed: null,
      weight,
    }));

  it('is ok below min_samples even with failures (fail-open)', () => {
    const r = computeBudget(obs(3, 3), { slo: 0.9, minSamples: 10 });
    expect(r.measurable).toBe(false);
    expect(r.state).toBe('ok');
  });

  it('exhausts when burn exceeds 1.0', () => {
    // 12 obs, 3 bad, SLO 0.9 → tolerance 0.1 → burn = 3/(12*0.1) = 2.5
    const r = computeBudget(obs(12, 3), { slo: 0.9, minSamples: 10 });
    expect(r.measurable).toBe(true);
    expect(r.state).toBe('exhausted');
    expect(r.burn_ratio).toBeGreaterThan(1);
  });

  it('warns between 0.5 and 1.0', () => {
    // 20 obs, 1 bad, SLO 0.9 → burn = 1/(20*0.1) = 0.5
    const r = computeBudget(obs(20, 1), { slo: 0.9, minSamples: 10 });
    expect(r.state).toBe('warning');
  });

  it('recovers as the window slides (no bad rows → ok)', () => {
    const r = computeBudget(obs(20, 0), { slo: 0.9, minSamples: 10 });
    expect(r.state).toBe('ok');
    expect(r.burn_ratio).toBe(0);
  });

  it('EXCLUDES shadow-route rows from the production budget', () => {
    const shadow: BudgetObservation[] = Array.from({ length: 20 }, () => ({
      source: 'judge',
      route: 'shadow',
      score: 0.1,
      passed: null,
      weight: 1,
    }));
    const r = computeBudget(shadow, { slo: 0.9, minSamples: 10 });
    expect(r.total_weighted).toBe(0);
    expect(r.state).toBe('ok');
  });

  it('counts a failed probe as bad, weighted', () => {
    const r = computeBudget(
      [{ source: 'probe', route: 'probe', score: null, passed: false, weight: 5 }],
      { slo: 0.9, minSamples: 1 },
    );
    expect(r.bad_weighted).toBe(5);
  });
});

describe('drift joint condition', () => {
  const emb = new HashEmbedder();
  const ref = {
    vectors: Array.from({ length: 6 }, () => emb.embed('cloud cost report finance quarterly')),
    scores: [0.9, 0.92, 0.88, 0.9, 0.91, 0.9],
  };
  const params = { inputThreshold: 0.5, scoreDropThreshold: 0.1, minCurrent: 5 };

  it('does not alert when only scores drop (no input shift)', () => {
    const cur = {
      vectors: Array.from({ length: 6 }, () => emb.embed('cloud cost report finance quarterly')),
      scores: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    };
    expect(computeDrift(cur, ref, params).drifting).toBe(false);
  });

  it('does not alert when only inputs shift (scores hold)', () => {
    const cur = {
      vectors: Array.from({ length: 6 }, () => emb.embed('vacation policy holiday leave days off')),
      scores: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    };
    const d = computeDrift(cur, ref, params);
    expect(d.input_drift).toBeGreaterThan(0.5);
    expect(d.drifting).toBe(false);
  });

  it('alerts on the JOINT condition', () => {
    const cur = {
      vectors: Array.from({ length: 6 }, () => emb.embed('vacation policy holiday leave days off')),
      scores: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    };
    expect(computeDrift(cur, ref, params).drifting).toBe(true);
  });

  it('is not evaluable below min_current', () => {
    const cur = { vectors: [emb.embed('x')], scores: [0.5] };
    expect(computeDrift(cur, ref, params).evaluable).toBe(false);
  });

  it('respects the cooldown', () => {
    const drift = computeDrift(
      {
        vectors: Array.from({ length: 6 }, () =>
          emb.embed('vacation policy holiday leave days off'),
        ),
        scores: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      },
      ref,
      params,
    );
    const now = new Date('2026-07-11T12:00:00Z');
    expect(driftAlertDue(drift, null, now, 6)).toBe(true);
    expect(driftAlertDue(drift, new Date('2026-07-11T11:00:00Z'), now, 6)).toBe(false);
    expect(driftAlertDue(drift, new Date('2026-07-11T05:00:00Z'), now, 6)).toBe(true);
    expect(EMBEDDING_DIM).toBe(256);
  });
});

describe('degradation ladder', () => {
  const base: LadderSignals = {
    budget: {
      state: 'ok',
      burn_ratio: 0,
      slo: 0.9,
      total_weighted: 20,
      bad_weighted: 0,
      n: 20,
      measurable: true,
    },
    consecutiveProbeFailures: 0,
    consecutiveProbeCycles: 0,
    windowJudgeMean: 0.9,
    slo: 0.9,
    thresholds: { severe_probe_failures: 2, floor_probe_cycles: 4, floor_burn_ratio: 2.0 },
  };

  it('ok when healthy', () => {
    expect(computeLadderLevel(base).level).toBe('ok');
  });
  it('warning from a warning budget', () => {
    expect(
      computeLadderLevel({ ...base, budget: { ...base.budget, state: 'warning', burn_ratio: 0.6 } })
        .level,
    ).toBe('warning');
  });
  it('exhausted from an exhausted budget', () => {
    expect(
      computeLadderLevel({
        ...base,
        budget: { ...base.budget, state: 'exhausted', burn_ratio: 1.4 },
      }).level,
    ).toBe('exhausted');
  });
  it('severe on consecutive probe failures', () => {
    expect(computeLadderLevel({ ...base, consecutiveProbeFailures: 2 }).level).toBe('severe');
  });
  it('severe when window judge mean falls below SLO−0.2', () => {
    expect(computeLadderLevel({ ...base, windowJudgeMean: 0.65 }).level).toBe('severe');
  });
  it('floor on full-cycle probe failures (the trusted golden-probe signal)', () => {
    expect(computeLadderLevel({ ...base, consecutiveProbeCycles: 4 }).level).toBe('floor');
  });
  it('judge-burn ALONE (burn_ratio >= floor, zero probe failures) reaches severe, NOT floor', () => {
    // SECURITY (cross-tenant DoS): burn_ratio is judge-derived on attacker-chosen
    // inputs. It must escalate at most to the REVERSIBLE severe rung — never to
    // the irreversible floor/auto-suspend — so adversarial input volume against a
    // shared agent cannot force a platform-wide suspend.
    const judgeBurnOnly = computeLadderLevel({
      ...base,
      consecutiveProbeFailures: 0,
      consecutiveProbeCycles: 0,
      windowJudgeMean: 0.1,
      budget: { ...base.budget, state: 'exhausted', burn_ratio: 2.1, measurable: true },
    });
    expect(judgeBurnOnly.level).toBe('severe');
    expect(judgeBurnOnly.level).not.toBe('floor');
  });
  it('judge-burn + full-cycle probe failures still floors (probes corroborate)', () => {
    expect(
      computeLadderLevel({
        ...base,
        consecutiveProbeFailures: 4,
        consecutiveProbeCycles: 4,
        budget: { ...base.budget, state: 'exhausted', burn_ratio: 2.1, measurable: true },
      }).level,
    ).toBe('floor');
  });

  it('fires log_owner entering warning, abort entering severe, suspend+page entering floor', () => {
    expect(planLadderTransition('ok', 'warning')).toEqual({
      changed: true,
      actions: ['log_owner'],
      page: false,
    });
    const toSevere = planLadderTransition('ok', 'severe');
    expect(toSevere.actions).toContain('abort_deployment');
    // A jump straight to the floor crosses the severe rung, so it both aborts
    // any in-flight deployment AND suspends.
    const toFloor = planLadderTransition('exhausted', 'floor');
    expect(toFloor.actions).toEqual(['abort_deployment', 'suspend']);
    expect(toFloor.page).toBe(true);
    // Entering the floor directly from severe only needs the suspend.
    expect(planLadderTransition('severe', 'floor').actions).toEqual(['suspend']);
  });

  it('does not re-fire actions while resident, and records recovery', () => {
    expect(planLadderTransition('severe', 'severe')).toEqual({
      changed: false,
      actions: [],
      page: false,
    });
    expect(planLadderTransition('floor', 'ok')).toEqual({
      changed: true,
      actions: [],
      page: false,
    });
  });
});
