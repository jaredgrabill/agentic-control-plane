import type { BudgetResult } from './budget.js';
import type { DriftResult } from './drift.js';

/**
 * The degradation ladder, worst-last. Each rung is strictly more severe than
 * the last and wires to a REAL mechanism (no new demotion primitive):
 *   ok        — healthy.
 *   warning   — score dip; alert the owner (budget_state_changed + log).
 *   exhausted — budget burned; change-freeze active (pull-enforced by the
 *               deployment workflow, nothing to push here).
 *   severe    — sustained failure; abort an in-flight deployment (item-4 API,
 *               canary→shadow). A solo active version has no lateral demote —
 *               freeze + alert stand (honest v0 limit). This is where CATASTROPHIC
 *               judge-burn tops out — it is reversible (window recovery / redeploy).
 *   floor     — SLO floor breached ON THE TRUSTED PROBE SIGNAL (consecutive
 *               full-cycle golden-probe failures); auto-suspend = kill switch
 *               tier 1 (registry state → suspended) and page the owner. This rung
 *               is IRREVERSIBLE (needs a human admin to reinstate), so it requires
 *               golden-probe corroboration and is NEVER reachable from judge-burn
 *               alone — see computeLadderLevel for the cross-tenant rationale.
 */
export type LadderLevel = 'ok' | 'warning' | 'exhausted' | 'severe' | 'floor';

const ORDER: Record<LadderLevel, number> = {
  ok: 0,
  warning: 1,
  exhausted: 2,
  severe: 3,
  floor: 4,
};

export interface LadderSignals {
  budget: BudgetResult;
  /** Consecutive probe failures (resets to 0 on a probe pass). */
  consecutiveProbeFailures: number;
  /** Consecutive FULL-CYCLE probe failures (a whole probe cycle failed). */
  consecutiveProbeCycles: number;
  /** Mean judged score over the window, or null when no judge samples exist. */
  windowJudgeMean: number | null;
  slo: number;
  thresholds: {
    severe_probe_failures: number;
    floor_probe_cycles: number;
    floor_burn_ratio: number;
  };
}

export interface LadderVerdict {
  level: LadderLevel;
  reasons: string[];
}

/** Computes the ladder rung from the current signals (pure). */
export function computeLadderLevel(s: LadderSignals): LadderVerdict {
  const reasons: string[] = [];

  // AUTO-SUSPEND (floor) requires golden-probe CORROBORATION. It fires ONLY on
  // consecutive full-cycle probe failures — the trusted, fixed-input signal —
  // NEVER on judge-derived burn_ratio. Rationale (cross-tenant DoS): the budget
  // aggregates by agent_id with no tenant dimension, judge samples score
  // ATTACKER-CHOSEN inputs, and this rung is both COARSE (whole agent, all
  // tenants/versions) and IRREVERSIBLE (a human admin must reinstate). If
  // judge-burn alone could reach it, a single tenant sending adversarial inputs
  // to a SHARED agent (e.g. one sampled at 100%) could make the judge honestly
  // score them bad and force a platform-wide suspend that also takes down other
  // tenants. Golden probes run fixed inputs the attacker cannot influence, so
  // only genuine degradation — not adversarial input volume — can auto-suspend.
  const floorByCycles = s.consecutiveProbeCycles >= s.thresholds.floor_probe_cycles;
  if (floorByCycles) {
    reasons.push(`${s.consecutiveProbeCycles} consecutive full-cycle probe failures`);
    return { level: 'floor', reasons };
  }

  const severeByProbes = s.consecutiveProbeFailures >= s.thresholds.severe_probe_failures;
  // The judge-mean rung only applies once the budget is measurable — a single
  // bad sample must not trip severe (same fail-open principle as the budget).
  const severeByMean =
    s.budget.measurable && s.windowJudgeMean !== null && s.windowJudgeMean < s.slo - 0.2;
  // Catastrophic judge-burn (attacker-influenceable) escalates only as far as the
  // REVERSIBLE severe rung — abort an in-flight deployment — never to the
  // irreversible floor/suspend. Freeze (exhausted, below) already blocks NEW
  // deployments; severe additionally aborts one already in flight.
  const severeByBurn = s.budget.measurable && s.budget.burn_ratio >= s.thresholds.floor_burn_ratio;
  if (severeByProbes) reasons.push(`${s.consecutiveProbeFailures} consecutive probe failures`);
  if (severeByMean) reasons.push(`window judge mean ${s.windowJudgeMean} < SLO−0.2`);
  if (severeByBurn)
    reasons.push(
      `burn_ratio ${s.budget.burn_ratio} >= ${s.thresholds.floor_burn_ratio} (judge-burn — reversible demote only)`,
    );
  if (severeByProbes || severeByMean || severeByBurn) return { level: 'severe', reasons };

  if (s.budget.state === 'exhausted') {
    reasons.push(`error budget exhausted (burn_ratio ${s.budget.burn_ratio})`);
    return { level: 'exhausted', reasons };
  }
  if (s.budget.state === 'warning') {
    reasons.push(`error budget warning (burn_ratio ${s.budget.burn_ratio})`);
    return { level: 'warning', reasons };
  }
  return { level: 'ok', reasons };
}

/** A concrete action a rung transition requires the service to take. */
export type LadderAction = 'log_owner' | 'abort_deployment' | 'suspend';

export interface LadderTransition {
  changed: boolean;
  actions: LadderAction[];
  /** True when the new level is the SLO floor (the budget_state_changed pages). */
  page: boolean;
}

/**
 * Plans the actions a level transition requires. Actions fire only on ENTERING
 * a rung (an upward crossing), never while resident — so a deployment is
 * aborted once on reaching severe, not re-aborted every ingest. A downward
 * transition (window recovery) fires nothing but is still recorded, so the
 * budget_state_changed audit tracks recovery too.
 */
export function planLadderTransition(prev: LadderLevel, next: LadderLevel): LadderTransition {
  const changed = prev !== next;
  const rose = ORDER[next] > ORDER[prev];
  const actions: LadderAction[] = [];
  if (rose && ORDER[next] >= ORDER.warning && ORDER[prev] < ORDER.warning) {
    // Entered the alerting band from ok.
    actions.push('log_owner');
  }
  if (rose && ORDER[next] >= ORDER.severe && ORDER[prev] < ORDER.severe) {
    actions.push('abort_deployment');
  }
  if (rose && ORDER[next] >= ORDER.floor && ORDER[prev] < ORDER.floor) {
    actions.push('suspend');
  }
  return { changed, actions, page: next === 'floor' };
}

/** Whether a drift alert may fire now (joint condition met AND cooldown elapsed). */
export function driftAlertDue(
  drift: DriftResult,
  lastAlertAt: Date | null,
  now: Date,
  cooldownH: number,
): boolean {
  if (!drift.drifting) return false;
  if (lastAlertAt === null) return true;
  return now.getTime() - lastAlertAt.getTime() >= cooldownH * 3600_000;
}
