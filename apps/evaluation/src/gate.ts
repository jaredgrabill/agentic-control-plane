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

/** The complete acp-eval-gate/v1 key set; anything else is a typo. */
const GATE_CONFIG_KEYS = new Set(['schema', 'description', 'tolerances', 'default_tolerance']);

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalid(file: string, detail: string): never {
  throw new Error(`invalid gate config ${file}: ${detail}`);
}

/**
 * Parses and shape-checks a gate.json document. Both load sites (the
 * runner's `<dir>/evals/gate.json` and the `gate --gates` flag) go through
 * here: a config that widens or zeroes an agent's tolerances must never be
 * half-read. Unknown keys are REJECTED, not ignored — a typo like
 * `"tolerence"` would otherwise silently hand the agent builtin tolerances.
 * Tolerances must be finite numbers in [0, 1]. Every error names the file.
 */
export function loadGateConfig(text: string, file: string): GateConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    invalid(file, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(file, 'expected a JSON object');
  }
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!GATE_CONFIG_KEYS.has(key)) invalid(file, `unknown key "${key}"`);
  }
  if (config.schema !== undefined && config.schema !== 'acp-eval-gate/v1') {
    invalid(file, `schema must be "acp-eval-gate/v1", got ${JSON.stringify(config.schema)}`);
  }
  if (config.description !== undefined && typeof config.description !== 'string') {
    invalid(file, 'description must be a string');
  }
  if (config.default_tolerance !== undefined && !isUnitInterval(config.default_tolerance)) {
    invalid(
      file,
      `default_tolerance must be a finite number in [0, 1], got ${JSON.stringify(config.default_tolerance)}`,
    );
  }
  if (config.tolerances !== undefined) {
    if (
      typeof config.tolerances !== 'object' ||
      config.tolerances === null ||
      Array.isArray(config.tolerances)
    ) {
      invalid(file, 'tolerances must be an object mapping metric names to numbers');
    }
    for (const [metric, value] of Object.entries(config.tolerances)) {
      if (!isUnitInterval(value)) {
        invalid(
          file,
          `tolerances.${metric} must be a finite number in [0, 1], got ${JSON.stringify(value)}`,
        );
      }
    }
  }
  return config;
}

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
