/**
 * The eval gate: pure tolerance math over an EvalBaseline and a candidate
 * EvalReport (evaluation.md gate 2 — "golden set ≥ baseline − tolerance").
 * Gates are baseline-relative, never absolute, and every metric is assumed
 * higher-is-better on [0, 1] (the acp-eval-report/v1 contract).
 */

import type { EvalBaseline, EvalReport } from '@acp/protocol';

/** Shape of an agent's optional `<dir>/evals/gate.json`. */
export interface GateConfig {
  schema?: 'acp-eval-gate/v1';
  description?: string;
  /** Per-metric allowed drop below baseline. */
  tolerances?: Record<string, number>;
  /** Fallback for metrics not named in `tolerances`. */
  default_tolerance?: number;
}

export interface GateResult {
  ok: boolean;
  violations: string[];
}

/**
 * Defaults when an agent ships no gate.json: small allowances for the two
 * metrics that can wobble with retrieval changes, none for abstention —
 * an agent that starts guessing (or refusing) is never "within tolerance".
 */
export const BUILTIN_TOLERANCES: Record<string, number> = {
  pass_rate: 0.05,
  citation_precision: 0.02,
  abstention_accuracy: 0.0,
};

/** Applied to extra domain metrics with no builtin and no config entry. */
export const FALLBACK_TOLERANCE = 0.05;

/** Precedence: config.tolerances[metric] → config.default_tolerance → builtin → fallback. */
export function resolveTolerance(metric: string, config?: GateConfig): number {
  return (
    config?.tolerances?.[metric] ??
    config?.default_tolerance ??
    BUILTIN_TOLERANCES[metric] ??
    FALLBACK_TOLERANCE
  );
}

/**
 * Gates a candidate report against the recorded baseline.
 *
 * Order matters: an agent mismatch or a golden-suite change short-circuits —
 * comparing metrics across different suites answers a question nobody asked.
 * A metric fails iff `candidate < baseline − tolerance − 1e-9` (the epsilon
 * absorbs float noise, not regressions). Extra candidate metrics with no
 * baseline entry are ignored; every baseline metric must appear in the report.
 */
export function applyGate(
  baseline: EvalBaseline,
  report: EvalReport,
  config?: GateConfig,
): GateResult {
  if (baseline.agent_id !== report.agent_id) {
    return {
      ok: false,
      violations: [
        `baseline is for agent ${baseline.agent_id} but the report is for ${report.agent_id}`,
      ],
    };
  }
  if (baseline.suite.digest !== report.suite.digest) {
    return {
      ok: false,
      violations: [
        `golden suite changed (baseline ${baseline.suite.digest}, candidate ` +
          `${report.suite.digest}) — refresh evals/baseline.json in this PR: ` +
          'node apps/evaluation/dist/main.js baseline --report <report> --out <dir>/evals/baseline.json',
      ],
    };
  }
  const violations: string[] = [];
  for (const [metric, base] of Object.entries(baseline.metrics)) {
    const candidate = report.metrics[metric];
    if (candidate === undefined) {
      violations.push(`baseline metric ${metric} is missing from the candidate report`);
      continue;
    }
    const tolerance = resolveTolerance(metric, config);
    if (candidate < base - tolerance - 1e-9) {
      violations.push(
        `${metric} ${candidate.toFixed(4)} < baseline ${base.toFixed(4)} − tolerance ${tolerance}`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}
