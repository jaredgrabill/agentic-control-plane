/**
 * Distills an accepted EvalReport into the EvalBaseline that gets committed
 * at `<dir>/evals/baseline.json` and recorded on the registry card.
 */

import type { EvalBaseline, EvalReport } from '@acp/protocol';

/**
 * `harness` records which SDK produced the accepted run, so a later report
 * from a different harness is visibly cross-harness in review. When the
 * report carries `generated_at`, `recorded_at` reuses it — the baseline is
 * then a pure function of the report and regenerating from the same report
 * is byte-identical; the injected clock only covers reports without one.
 */
export function baselineFromReport(report: EvalReport, now?: () => Date): EvalBaseline {
  return {
    schema: 'acp-eval-baseline/v1',
    agent_id: report.agent_id,
    agent_version: report.agent_version,
    metrics: report.metrics,
    suite: report.suite,
    harness: report.sdk,
    recorded_at: report.generated_at ?? (now?.() ?? new Date()).toISOString(),
  };
}
