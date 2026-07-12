import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Calibration is the hard gate between "we have a judge" and "we trust the
 * judge to score production traffic". A judge scores nothing until a
 * calibration record proves it agrees with human labels on a golden case set
 * at or above the agreement floor. The gate is keyed on {rubric_digest,
 * model_class}: a rubric edit or a model-class swap invalidates the old
 * calibration and REFUSES to score (no LLM call) until re-calibrated. This is
 * the deliberate inverse of the error-budget rule — an unproven judge is
 * fail-CLOSED (refuse), an unmeasurable budget is fail-OPEN (ok).
 */

export const CALIBRATION_SCHEMA_ID = 'acp-judge-calibration/v1';
export const DEFAULT_MIN_AGREEMENT = 0.85;

/** One golden calibration case: an input/output pair with its human label. */
export interface CalibrationCase {
  name: string;
  input: string;
  /** The candidate answer under judgement. */
  output: string;
  /** citations the agent returned, if the case exercises groundedness. */
  citations?: string[];
  /** The human ground truth: true = this answer should pass (score >= 0.7). */
  label: boolean;
}

/**
 * A committed calibration result: the agreement a judge achieved on a golden
 * case set, pinned to the exact rubric bytes and model class it was measured
 * against. assertCalibrated matches on {rubric_digest, model_class}.
 */
export interface CalibrationRecord {
  schema: 'acp-judge-calibration/v1';
  rubric: string;
  rubric_digest: string;
  model_class: string;
  /** Fraction of cases where (score >= 0.7) === label, in [0,1]. */
  agreement: number;
  /** The floor this record was gated against when produced. */
  min_agreement: number;
  /** Number of scored cases. */
  n: number;
  generated_at: string;
}

/** Agreement = fraction of cases where the judge's pass/fail matches the label. */
export function computeAgreement(results: { label: boolean; score: number }[]): number {
  if (results.length === 0) return 0;
  const agreed = results.filter((r) => r.score >= 0.7 === r.label).length;
  return agreed / results.length;
}

/**
 * The runtime calibration gate. Returns the matching record when a judge is
 * calibrated for this rubric+model-class at/above the floor, or an
 * `uncalibrated` refusal (no matching record, a rubric-digest mismatch, or
 * below-floor agreement). The caller must NOT make an LLM call on a refusal.
 */
export type CalibrationCheck =
  | { calibrated: true; record: CalibrationRecord }
  | { calibrated: false; outcome: 'uncalibrated'; detail: string };

export function assertCalibrated(
  records: CalibrationRecord[],
  params: { rubricDigest: string; modelClass: string; minAgreement?: number },
): CalibrationCheck {
  const floor = params.minAgreement ?? DEFAULT_MIN_AGREEMENT;
  const forClass = records.filter((r) => r.model_class === params.modelClass);
  if (forClass.length === 0) {
    return {
      calibrated: false,
      outcome: 'uncalibrated',
      detail: `no calibration record for model_class ${params.modelClass}`,
    };
  }
  const match = forClass.find((r) => r.rubric_digest === params.rubricDigest);
  if (match === undefined) {
    return {
      calibrated: false,
      outcome: 'uncalibrated',
      detail:
        `calibration for model_class ${params.modelClass} was measured against a different ` +
        `rubric (have ${forClass.map((r) => r.rubric_digest).join(', ')}, need ${params.rubricDigest}) ` +
        '— re-calibrate after a rubric edit',
    };
  }
  if (match.agreement < floor) {
    return {
      calibrated: false,
      outcome: 'uncalibrated',
      detail: `judge agreement ${match.agreement.toFixed(3)} is below the floor ${floor}`,
    };
  }
  return { calibrated: true, record: match };
}

/**
 * Loads the committed DEV calibration records (calibration/calibration.dev.json).
 * These prove the judge machinery in dev/CI; a real deployment injects records
 * produced by the `calibrate` CLI against a real provider.
 */
export function loadDevCalibration(): CalibrationRecord[] {
  const url = new URL('../calibration/calibration.dev.json', import.meta.url);
  const doc = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as {
    records: CalibrationRecord[];
  };
  return doc.records;
}

/**
 * Loads the committed calibration cases for a rubric. `dev: true` loads the
 * scripted [[dev-llm]] case set (cases-dev.json); otherwise the human-labelled
 * golden set (cases.json).
 */
export function loadCalibrationCases(
  rubricId: string,
  opts?: { dev?: boolean },
): CalibrationCase[] {
  const file = opts?.dev === true ? 'cases-dev.json' : 'cases.json';
  const url = new URL(`../calibration/${rubricId}/${file}`, import.meta.url);
  const doc = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { cases: CalibrationCase[] };
  return doc.cases;
}
