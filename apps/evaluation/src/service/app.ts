import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import {
  computeBudget,
  computeDrift,
  computeLadderLevel,
  driftAlertDue,
  parseScoreIngest,
  planLadderTransition,
  type BudgetResult,
  type LadderLevel,
  type OnlineEvalConfig,
  type ScoreIngest,
} from '@acp/online-eval';
import {
  AuthError,
  createHttpServer,
  scopesOf,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PgScoresStore, QualityState } from './store.js';

export const EVAL_AUDIENCE = 'acp:eval';

/** Owner + SLO for an agent (from its manifest; the ladder pages the owner). */
export interface AgentMeta {
  slo: number;
  owner: string;
}

/** The degradation-ladder's real action surface (item-4 abort, kill-switch suspend). */
export interface LadderActions {
  /** Abort an in-flight deployment (item-4 signal → canary demotes to shadow). */
  abortDeployment(agentId: string): Promise<void>;
  /** Auto-suspend the agent = kill switch tier 1 (registry:suspend → suspended). */
  suspendAgent(agentId: string, reason: string): Promise<void>;
}

export interface EvalServiceDeps {
  verifier: JwtVerifier;
  store: PgScoresStore;
  config: OnlineEvalConfig;
  audit: { publish(event: AuditEvent): Promise<void> };
  actions: LadderActions;
  /** Resolves an agent's SLO + owner (registry-backed; falls back to config default). */
  agentMeta(agentId: string): Promise<AgentMeta>;
  logger: Logger;
  now?: () => Date;
}

export function buildEvalService(deps: EvalServiceDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'evaluation', logger: deps.logger });
  const now = (): Date => deps.now?.() ?? new Date();
  const windowStart = (): Date =>
    new Date(now().getTime() - deps.config.budget.window_h * 3600_000);

  // POST /v1/scores — ingest a judged sample / probe / human label, then run the
  // whole enforcement brain (budget → drift → ladder) synchronously so the
  // producer's retry-safe POST also drives freezes and sanctions.
  app.post('/v1/scores', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'eval:write');
    let ingest: ScoreIngest;
    try {
      ingest = parseScoreIngest(request.body);
    } catch (err) {
      throw new AuthError(err instanceof Error ? err.message : String(err), 400);
    }
    const inserted = await deps.store.insert(ingest);
    // A duplicate (idempotent replay) must NOT re-run counters or re-fire
    // ladder actions — the first ingest already did.
    if (inserted) {
      await runLadder(deps, ingest);
    }
    return reply.status(202).send({ accepted: true, deduplicated: !inserted });
  });

  // GET /v1/agents/:id/quality — the SLI + budget + drift view. checkQualityFreeze
  // (deployment) and operators read this. The budget is recomputed here, never
  // stored, so it reflects the current window.
  app.get('/v1/agents/:agent_id/quality', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'eval:read');
    const { agent_id } = request.params as { agent_id: string };
    const since = windowStart();
    const [sli, observations, meta, state] = await Promise.all([
      deps.store.sli(agent_id, since),
      deps.store.budgetObservations(agent_id, since),
      deps.agentMeta(agent_id),
      deps.store.getQualityState(agent_id),
    ]);
    const budget = computeBudget(observations, {
      slo: meta.slo,
      minSamples: deps.config.budget.min_samples,
    });
    return reply.send({
      agent_id,
      window_h: deps.config.budget.window_h,
      sli,
      budget: {
        slo: budget.slo,
        burn_ratio: budget.burn_ratio,
        state: budget.state,
        measurable: budget.measurable,
      },
      level: state?.level ?? 'ok',
      // A freeze is active iff the budget is exhausted OR the ladder has driven
      // the agent below (severe/floor). checkQualityFreeze reads this.
      frozen: budget.state === 'exhausted' || isBelow(state?.level ?? 'ok', 'exhausted'),
    });
  });

  // GET /v1/scores/aggregate — mean judged score by version+route+window. The
  // deployment GateEvaluator's ScoresClient reads this to fill metrics.quality.
  app.get('/v1/scores/aggregate', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'eval:read');
    const q = request.query as {
      agent_id?: string;
      agent_version?: string;
      route?: string;
      since?: string;
    };
    if (!q.agent_id || !q.agent_version || !q.route) {
      throw new AuthError('agent_id, agent_version and route query params are required', 400);
    }
    const since = q.since !== undefined ? new Date(q.since) : windowStart();
    const agg = await deps.store.versionRouteQuality(q.agent_id, q.agent_version, q.route, since);
    return reply.send(agg);
  });

  return app;
}

const ORDER: Record<LadderLevel, number> = { ok: 0, warning: 1, exhausted: 2, severe: 3, floor: 4 };
const isBelow = (level: LadderLevel, than: LadderLevel): boolean => ORDER[level] > ORDER[than];

/**
 * The enforcement pass run after each NEW ingest: update probe counters,
 * recompute the budget from the window, compute the ladder level, fire the
 * one-shot transition actions, emit the budget/drift audits, and persist the
 * new quality state.
 */
async function runLadder(deps: EvalServiceDeps, ingest: ScoreIngest): Promise<void> {
  const nowDate = deps.now?.() ?? new Date();
  const since = new Date(nowDate.getTime() - deps.config.budget.window_h * 3600_000);
  const prior: QualityState = (await deps.store.getQualityState(ingest.agent_id)) ?? {
    agent_id: ingest.agent_id,
    level: 'ok',
    burn_ratio: 0,
    consecutive_probe_failures: 0,
    consecutive_probe_cycles: 0,
    last_drift_at: null,
  };

  // Probe counters: a probe pass resets the streak; a probe failure extends it.
  // v0 treats each probe result as a cycle (the dev suite is one case/target).
  let probeFailures = prior.consecutive_probe_failures;
  if (ingest.source === 'probe') {
    probeFailures = ingest.passed === false ? probeFailures + 1 : 0;
  }

  const meta = await deps.agentMeta(ingest.agent_id);
  const [observations, windowJudgeMean] = await Promise.all([
    deps.store.budgetObservations(ingest.agent_id, since),
    deps.store.windowJudgeMean(ingest.agent_id, since),
  ]);
  const budget = computeBudget(observations, {
    slo: meta.slo,
    minSamples: deps.config.budget.min_samples,
  });

  const verdict = computeLadderLevel({
    budget,
    consecutiveProbeFailures: probeFailures,
    consecutiveProbeCycles: probeFailures,
    windowJudgeMean,
    slo: meta.slo,
    thresholds: {
      severe_probe_failures: deps.config.drift.severe_probe_failures,
      floor_probe_cycles: deps.config.drift.floor_probe_cycles,
      floor_burn_ratio: deps.config.drift.floor_burn_ratio,
    },
  });
  const transition = planLadderTransition(prior.level, verdict.level);

  if (transition.changed) {
    await emitBudgetStateChanged(
      deps,
      ingest.agent_id,
      prior.level,
      verdict.level,
      budget,
      meta,
      transition.page,
      verdict.reasons,
    );
  }
  for (const action of transition.actions) {
    try {
      if (action === 'abort_deployment') await deps.actions.abortDeployment(ingest.agent_id);
      else if (action === 'suspend') {
        await deps.actions.suspendAgent(
          ingest.agent_id,
          `quality_slo_floor: ${verdict.reasons.join('; ')}`,
        );
      } else
        deps.logger.warn(
          { agent_id: ingest.agent_id, owner: meta.owner },
          'quality alert — notify owner',
        );
    } catch (err) {
      // A ladder action failing must not crash ingest — log and carry on; the
      // next ingest re-evaluates and retries the transition.
      deps.logger.error({ err, action, agent_id: ingest.agent_id }, 'ladder action failed');
    }
  }

  // Drift is alert-only, on the JOINT condition, per (agent, capability), on a
  // judged ingest carrying an embedding.
  let lastDriftAt = prior.last_drift_at;
  if (ingest.source === 'judge' && ingest.input_embedding != null) {
    lastDriftAt = await maybeAlertDrift(deps, ingest, nowDate, since, prior.last_drift_at);
  }

  await deps.store.upsertQualityState({
    agent_id: ingest.agent_id,
    level: verdict.level,
    burn_ratio: budget.burn_ratio,
    consecutive_probe_failures: probeFailures,
    consecutive_probe_cycles: probeFailures,
    last_drift_at: lastDriftAt,
  });
}

async function maybeAlertDrift(
  deps: EvalServiceDeps,
  ingest: ScoreIngest,
  nowDate: Date,
  since: Date,
  lastDriftAt: Date | null,
): Promise<Date | null> {
  const refStart = new Date(since.getTime() - deps.config.drift.reference_days * 24 * 3600_000);
  const windows = await deps.store.driftWindows(
    ingest.agent_id,
    ingest.capability,
    since,
    refStart,
  );
  const drift = computeDrift(windows.current, windows.reference, {
    inputThreshold: deps.config.drift.input_threshold,
    scoreDropThreshold: deps.config.drift.score_drop_threshold,
    minCurrent: deps.config.drift.min_current,
  });
  if (!driftAlertDue(drift, lastDriftAt, nowDate, deps.config.drift.cooldown_h)) {
    return lastDriftAt;
  }
  await deps.audit.publish({
    event_id: randomUUID(),
    occurred_at: nowDate.toISOString(),
    tenant: 'platform',
    event_type: 'eval.drift_detected',
    actor: { principal: 'svc:evaluation', delegation_chain: [{ sub: 'svc:evaluation' }] },
    action: { name: 'eval.drift_detected' },
    artifacts: { agent_id: ingest.agent_id },
    details: {
      capability: ingest.capability,
      input_drift: drift.input_drift,
      score_drop: drift.score_drop,
      reference_mean: drift.reference_mean,
      current_mean: drift.current_mean,
    },
  });
  return nowDate;
}

async function emitBudgetStateChanged(
  deps: EvalServiceDeps,
  agentId: string,
  from: LadderLevel,
  to: LadderLevel,
  budget: BudgetResult,
  meta: AgentMeta,
  page: boolean,
  reasons: string[],
): Promise<void> {
  await deps.audit.publish({
    event_id: randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    tenant: 'platform',
    event_type: 'eval.budget_state_changed',
    actor: { principal: 'svc:evaluation', delegation_chain: [{ sub: 'svc:evaluation' }] },
    action: { name: 'eval.budget_state_changed' },
    artifacts: { agent_id: agentId },
    details: {
      from,
      to,
      burn_ratio: budget.burn_ratio,
      slo: budget.slo,
      owner: meta.owner,
      page,
      reasons,
    },
  });
}

async function authenticate(
  deps: EvalServiceDeps,
  request: FastifyRequest,
): Promise<PlatformClaims> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  return deps.verifier.verify(header.slice('Bearer '.length), EVAL_AUDIENCE);
}

function requireScope(claims: PlatformClaims, scope: string): void {
  if (!scopesOf(claims).includes(scope)) {
    throw new AuthError(`principal ${claims.sub} lacks scope ${scope}`, 403);
  }
}
