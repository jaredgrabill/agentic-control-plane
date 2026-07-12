import { centroid, cosineSimilarity } from '@acp/embedding';

export interface DriftResult {
  /** 1 − cosine(current centroid, reference centroid). */
  input_drift: number;
  /** mean_reference − mean_current (positive = scores dropped). */
  score_drop: number;
  reference_mean: number;
  current_mean: number;
  /** True only on the JOINT condition (input drifted AND scores dropped). */
  drifting: boolean;
  /** False when the current window has too few samples to judge drift. */
  evaluable: boolean;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * v0 drift over the dev-hash-embed@1 lexical embedding: a weak but genuine
 * statistic (model-swappable behind the same interface). Input drift is the
 * cosine distance between the current window's input centroid and a reference
 * window's; score drop is the fall in mean judged score. An alert fires ONLY
 * on the JOINT condition — inputs that shifted AND quality that fell — so a
 * benign topic shift (drift without a score drop) or ordinary noise (a score
 * dip without an input shift) does not page. The budget rungs act on the score
 * independently; drift is alert-only.
 */
export function computeDrift(
  current: { vectors: number[][]; scores: number[] },
  reference: { vectors: number[][]; scores: number[] },
  params: { inputThreshold: number; scoreDropThreshold: number; minCurrent: number },
): DriftResult {
  const evaluable = current.vectors.length >= params.minCurrent && reference.vectors.length > 0;
  const inputDrift = evaluable
    ? 1 - cosineSimilarity(centroid(current.vectors), centroid(reference.vectors))
    : 0;
  const referenceMean = mean(reference.scores);
  const currentMean = mean(current.scores);
  const scoreDrop = referenceMean - currentMean;
  const drifting =
    evaluable && inputDrift > params.inputThreshold && scoreDrop > params.scoreDropThreshold;
  return {
    input_drift: Number(inputDrift.toFixed(4)),
    score_drop: Number(scoreDrop.toFixed(4)),
    reference_mean: Number(referenceMean.toFixed(4)),
    current_mean: Number(currentMean.toFixed(4)),
    drifting,
    evaluable,
  };
}
