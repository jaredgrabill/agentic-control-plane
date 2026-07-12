import { createHash } from 'node:crypto';
import type { OnlineEvalConfig } from './config.js';

export interface SampleDecision {
  selected: boolean;
  /** The effective percent this (task, step) was compared against. */
  percent: number;
}

/**
 * Decides whether one step is judged, deterministically per (task_id, step_id)
 * so a replay reaches the same decision and the choice is independent of the
 * version-pinning bucket (which uses task_id alone). The rate is the per-agent
 * override or the default; a shadow soak BOOSTS to 100 so every paired
 * candidate/incumbent step is judged for the deployment gate.
 */
export function decideJudgeSample(
  cfg: OnlineEvalConfig['sample'],
  params: { taskId: string; stepId: string; agentId: string; boost?: boolean },
): SampleDecision {
  if (params.boost === true) return { selected: true, percent: 100 };
  const percent = cfg.per_agent?.[params.agentId] ?? cfg.default_percent;
  if (percent <= 0) return { selected: false, percent };
  if (percent >= 100) return { selected: true, percent };
  const digest = createHash('sha256').update(`${params.taskId}:${params.stepId}`).digest('hex');
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;
  return { selected: bucket < percent, percent };
}
