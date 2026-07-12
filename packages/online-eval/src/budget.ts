import type { ScoreRoute, ScoreSource } from './scores.js';

export const PASS_THRESHOLD = 0.7;

export type BudgetState = 'ok' | 'warning' | 'exhausted';

/** One weighted observation the budget folds. Shadow-route rows are excluded upstream. */
export interface BudgetObservation {
  source: ScoreSource;
  route: ScoreRoute;
  score: number | null;
  passed: boolean | null;
  weight: number;
}

export interface BudgetResult {
  state: BudgetState;
  burn_ratio: number;
  slo: number;
  total_weighted: number;
  bad_weighted: number;
  /** Number of rows (not weight) that counted. */
  n: number;
  /** False when below min_samples — the budget cannot measure, so it does not freeze. */
  measurable: boolean;
}

/** An observation is "bad" when a judged score misses the bar or a boolean failed. */
function isBad(o: BudgetObservation): boolean {
  if (o.passed === false) return true;
  if (o.score !== null && o.score < PASS_THRESHOLD) return true;
  return false;
}

/**
 * Recomputes the error budget from the CURRENT window on every call — there is
 * no sticky freeze. As the window slides past bad observations the burn ratio
 * falls and the state auto-recovers, which keeps dev/E2E self-healing.
 *
 * Shadow-route observations must be excluded by the caller (a pre-production
 * candidate must never freeze production). Below `minSamples` WEIGHTED
 * observations the budget is `ok` — a budget that cannot measure does not
 * freeze (the deliberate inverse of the calibration gate, which fails closed).
 */
export function computeBudget(
  observations: BudgetObservation[],
  params: { slo: number; minSamples: number },
): BudgetResult {
  const counted = observations.filter((o) => o.route !== 'shadow');
  let total = 0;
  let bad = 0;
  for (const o of counted) {
    total += o.weight;
    if (isBad(o)) bad += o.weight;
  }
  const measurable = total >= params.minSamples;
  // Guard the SLO tolerance denominator; an SLO of 1.0 would divide by zero.
  const tolerance = Math.max(1e-9, 1 - params.slo);
  const burn = total === 0 ? 0 : bad / (total * tolerance);
  let state: BudgetState = 'ok';
  if (measurable) {
    if (burn >= 1.0) state = 'exhausted';
    else if (burn >= 0.5) state = 'warning';
  }
  return {
    state,
    burn_ratio: Number(burn.toFixed(4)),
    slo: params.slo,
    total_weighted: Number(total.toFixed(4)),
    bad_weighted: Number(bad.toFixed(4)),
    n: counted.length,
    measurable,
  };
}
