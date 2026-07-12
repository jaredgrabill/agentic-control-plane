/**
 * Deployment gate evaluation v0 (D8) — deterministic, audit-derived, with a
 * judge seam. The audit stream IS the shadow-comparison store: the canary gate
 * folds `step.completed` events split by the executing agent version; the
 * shadow gate joins `deployment.shadow_result` records to their primary
 * `step.completed` on (task_id, step_id). Pure functions over already-fetched
 * audit events — no IO — so the math is unit-testable on synthetic folds.
 *
 * `GateReport.metrics.quality` is the **item-6 seam**: absent in v0, filled by
 * the judge consuming the same shadow_result records behind this same
 * interface. The DeploymentWorkflow's breach logic is metric-agnostic — it
 * treats any populated metric uniformly — so item 6 swaps the evaluator, not
 * the workflow.
 */

import type { AuditEvent } from '@acp/protocol';
import {
  priceUsageMicros,
  type PricedUsage,
  type ResolvedPriceBook,
} from '@acp/cost-meter/pricing';

export interface GateThresholds {
  /** Candidate success ratio may not fall more than this below the incumbent's. */
  max_success_delta: number;
  /** Candidate p95 latency may not exceed this multiple of the incumbent's. */
  max_p95_ratio: number;
  /** Candidate cost/step may not exceed this multiple of the incumbent's. */
  max_cost_ratio: number;
  /** Shadow: fraction of shadow steps that must complete for a pass. */
  min_shadow_completion: number;
  /** Shadow: minimum paired samples before the gate can decide. */
  min_shadow_samples: number;
  /** Item 6: candidate mean judged quality may not fall more than this below the incumbent's. */
  max_quality_delta: number;
  /** Item 6: minimum judged samples on EACH side before quality gates. */
  min_quality_samples: number;
}

/**
 * Paired judged-quality means for a gate (item 6, D8). Fetched from the eval
 * service scores store by version+route+window and passed in, so the evaluator
 * stays pure. A null mean or too-few samples on either side omits quality
 * entirely (the gate stays deterministic-only, exactly as item 4 shipped).
 */
export interface QualityInput {
  candidateMean: number | null;
  incumbentMean: number | null;
  candidateN: number;
  incumbentN: number;
}

/** Folds paired judged quality into a report: sets metrics.quality + a breach reason. */
function applyQuality(
  report: GateReport,
  thresholds: GateThresholds,
  quality?: QualityInput,
): void {
  if (quality === undefined) return;
  if (quality.candidateMean === null || quality.incumbentMean === null) return;
  if (
    quality.candidateN < thresholds.min_quality_samples ||
    quality.incumbentN < thresholds.min_quality_samples
  ) {
    return;
  }
  report.metrics.quality = Number(quality.candidateMean.toFixed(4));
  if (quality.incumbentMean - quality.candidateMean > thresholds.max_quality_delta) {
    report.reasons.push(
      `judged quality ${quality.candidateMean.toFixed(3)} is more than ` +
        `${thresholds.max_quality_delta} below the incumbent's ${quality.incumbentMean.toFixed(3)}`,
    );
  }
}

export interface GateReport {
  verdict: 'pass' | 'fail' | 'insufficient_data';
  samples: { candidate: number; incumbent: number };
  metrics: {
    success_ratio?: number;
    p95_latency_ms?: number;
    cost_per_step_usd?: number;
    /** ITEM 6 SEAM — paired judged quality; absent in v0. */
    quality?: number;
  };
  reasons: string[];
}

interface StepStat {
  status: string;
  durationMs: number | undefined;
  usage: PricedUsage | undefined;
}

/** Extracts the per-step stats the gate folds from a step.completed event. */
function stepStatOf(ev: AuditEvent): StepStat {
  const d = (ev.details ?? {}) as { status?: string; duration_ms?: number; usage?: PricedUsage };
  return {
    status: d.status ?? 'unknown',
    durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
    usage: d.usage ?? undefined,
  };
}

function p95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank p95 (deterministic; small samples round up to the top value).
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function successRatio(stats: StepStat[]): number | undefined {
  if (stats.length === 0) return undefined;
  return stats.filter((s) => s.status === 'completed').length / stats.length;
}

function costPerStepUsd(
  stats: StepStat[],
  book: ResolvedPriceBook | undefined,
): number | undefined {
  if (book === undefined || stats.length === 0) return undefined;
  let micros = 0;
  for (const s of stats) micros += priceUsageMicros(s.usage, book).micros;
  return micros / stats.length / 1_000_000;
}

export class GateEvaluator {
  /**
   * Canary gate: folds `step.completed` events in the window for the deployed
   * capabilities, split by the executing agent version (candidate vs
   * incumbent). BREACH iff the candidate's success ratio falls more than
   * max_success_delta below the incumbent's, OR its p95 latency exceeds
   * max_p95_ratio of the incumbent's, OR its cost/step exceeds max_cost_ratio
   * (cost compared only when both versions are priced). No candidate samples →
   * insufficient_data (the gate that cannot measure never passes).
   */
  evaluateCanary(
    events: AuditEvent[],
    params: {
      candidateVersion: string;
      incumbentVersion: string;
      thresholds: GateThresholds;
      priceBook?: ResolvedPriceBook | undefined;
      quality?: QualityInput;
    },
  ): GateReport {
    const completed = events.filter(
      (e) => e.event_type === 'step.completed' && e.details !== undefined,
    );
    const byVersion = (v: string): StepStat[] =>
      completed.filter((e) => e.artifacts?.agent_version === v).map(stepStatOf);
    const cand = byVersion(params.candidateVersion);
    const inc = byVersion(params.incumbentVersion);

    const reasons: string[] = [];
    const report: GateReport = {
      verdict: 'pass',
      samples: { candidate: cand.length, incumbent: inc.length },
      metrics: {},
      reasons,
    };
    if (cand.length === 0) {
      report.verdict = 'insufficient_data';
      reasons.push('no candidate samples in the window');
      return report;
    }

    const candSuccess = successRatio(cand);
    const incSuccess = successRatio(inc);
    if (candSuccess !== undefined) report.metrics.success_ratio = candSuccess;
    const candP95 = p95(cand.map((s) => s.durationMs).filter((n): n is number => n !== undefined));
    if (candP95 !== undefined) report.metrics.p95_latency_ms = candP95;
    const candCost = costPerStepUsd(cand, params.priceBook);
    if (candCost !== undefined) report.metrics.cost_per_step_usd = candCost;

    const t = params.thresholds;
    // Success-ratio breach (only when the incumbent has a baseline in-window).
    if (candSuccess !== undefined && incSuccess !== undefined) {
      if (candSuccess < incSuccess - t.max_success_delta) {
        reasons.push(
          `success ratio ${candSuccess.toFixed(3)} is more than ${t.max_success_delta} below ` +
            `the incumbent's ${incSuccess.toFixed(3)}`,
        );
      }
    }
    // p95 latency breach.
    const incP95 = p95(inc.map((s) => s.durationMs).filter((n): n is number => n !== undefined));
    if (candP95 !== undefined && incP95 !== undefined && incP95 > 0) {
      const ratio = candP95 / incP95;
      if (ratio > t.max_p95_ratio) {
        reasons.push(
          `p95 latency ${candP95}ms is ${ratio.toFixed(2)}x the incumbent's ${incP95}ms ` +
            `(> ${t.max_p95_ratio}x)`,
        );
      }
    }
    // Cost breach (only when BOTH versions are priced).
    const incCost = costPerStepUsd(inc, params.priceBook);
    if (candCost !== undefined && incCost !== undefined && incCost > 0) {
      const ratio = candCost / incCost;
      if (ratio > t.max_cost_ratio) {
        reasons.push(
          `cost/step $${candCost.toFixed(6)} is ${ratio.toFixed(2)}x the incumbent's ` +
            `$${incCost.toFixed(6)} (> ${t.max_cost_ratio}x)`,
        );
      }
    }

    applyQuality(report, t, params.quality);
    report.verdict = reasons.length > 0 ? 'fail' : 'pass';
    return report;
  }

  /**
   * Shadow gate: joins `deployment.shadow_result` records to their primary
   * `step.completed` on (task_id, step_id). Metrics are the paired-sample
   * count, the shadow completion ratio, the latency ratio, and the cost ratio.
   * Fewer than min_shadow_samples pairs → insufficient_data. BREACH iff the
   * completion ratio falls below min_shadow_completion, OR the latency/cost
   * ratio exceeds the thresholds.
   */
  evaluateShadow(
    events: AuditEvent[],
    params: {
      thresholds: GateThresholds;
      priceBook?: ResolvedPriceBook | undefined;
      quality?: QualityInput;
    },
  ): GateReport {
    const primaries = new Map<string, StepStat>();
    for (const e of events) {
      if (e.event_type !== 'step.completed') continue;
      const key = `${e.reason?.task_id ?? ''}:${e.reason?.step_id ?? ''}`;
      if (e.reason?.step_id !== undefined) primaries.set(key, stepStatOf(e));
    }
    const shadows: { shadow: StepStat; primary: StepStat }[] = [];
    for (const e of events) {
      if (e.event_type !== 'deployment.shadow_result') continue;
      const key = `${e.reason?.task_id ?? ''}:${e.reason?.step_id ?? ''}`;
      const primary = primaries.get(key);
      if (primary === undefined) continue; // unpaired — cannot compare
      const d = (e.details ?? {}) as { status?: string; duration_ms?: number; usage?: PricedUsage };
      shadows.push({
        shadow: {
          status: d.status ?? 'unknown',
          durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
          usage: d.usage ?? undefined,
        },
        primary,
      });
    }

    const reasons: string[] = [];
    const report: GateReport = {
      verdict: 'pass',
      samples: { candidate: shadows.length, incumbent: primaries.size },
      metrics: {},
      reasons,
    };
    if (shadows.length < params.thresholds.min_shadow_samples) {
      report.verdict = 'insufficient_data';
      reasons.push(
        `only ${shadows.length} paired shadow samples (< ${params.thresholds.min_shadow_samples})`,
      );
      return report;
    }

    const completion =
      shadows.filter((p) => p.shadow.status === 'completed').length / shadows.length;
    report.metrics.success_ratio = completion;
    const shadowP95 = p95(
      shadows.map((p) => p.shadow.durationMs).filter((n): n is number => n !== undefined),
    );
    if (shadowP95 !== undefined) report.metrics.p95_latency_ms = shadowP95;

    const t = params.thresholds;
    if (completion < t.min_shadow_completion) {
      reasons.push(
        `shadow completion ${completion.toFixed(3)} is below the floor ${t.min_shadow_completion}`,
      );
    }
    const primaryP95 = p95(
      shadows.map((p) => p.primary.durationMs).filter((n): n is number => n !== undefined),
    );
    if (shadowP95 !== undefined && primaryP95 !== undefined && primaryP95 > 0) {
      const ratio = shadowP95 / primaryP95;
      if (ratio > t.max_p95_ratio) {
        reasons.push(
          `shadow p95 latency ${shadowP95}ms is ${ratio.toFixed(2)}x the primary's ${primaryP95}ms`,
        );
      }
    }
    if (params.priceBook !== undefined) {
      const shadowCost = costPerStepUsd(
        shadows.map((p) => p.shadow),
        params.priceBook,
      );
      const primaryCost = costPerStepUsd(
        shadows.map((p) => p.primary),
        params.priceBook,
      );
      if (shadowCost !== undefined) report.metrics.cost_per_step_usd = shadowCost;
      if (shadowCost !== undefined && primaryCost !== undefined && primaryCost > 0) {
        const ratio = shadowCost / primaryCost;
        if (ratio > t.max_cost_ratio) {
          reasons.push(
            `shadow cost/step $${shadowCost.toFixed(6)} is ${ratio.toFixed(2)}x the primary's`,
          );
        }
      }
    }

    applyQuality(report, t, params.quality);
    report.verdict = reasons.length > 0 ? 'fail' : 'pass';
    return report;
  }
}
