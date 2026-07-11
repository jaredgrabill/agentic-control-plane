/**
 * code.ci_health — deterministic CI pass-rate summary: one ci_runs call,
 * the trailing window anchored on the tool's as_of date (never the wall
 * clock), aggregation computed here — the tool returns raw runs.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { CODE_FORGE, primaryProvenance } from '../tools.js';
import { requireRepo } from './dependency-query.js';

const DEFAULT_WINDOW_DAYS = 14;

interface CiHealthInput {
  repo?: string | undefined;
  window_days?: number | undefined;
}

export interface CiRun {
  run_id: string;
  status: string;
  message: string;
  finished_at: string;
  deploy_id?: string;
}

/** `as_of − windowDays` as a YYYY-MM-DD date (pure date arithmetic, UTC). */
export function windowStart(asOf: string, windowDays: number): string {
  const anchor = new Date(`${asOf}T00:00:00Z`);
  const since = new Date(anchor.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return since.toISOString().slice(0, 10);
}

export interface DeployRef {
  deploy_id: string;
  message: string;
  finished_at: string;
}

/** Pass/fail counts plus the deploys, oldest first, over the windowed runs. */
export function ciStats(runs: CiRun[]): {
  total: number;
  passed: number;
  failed: number;
  deploys: DeployRef[];
} {
  const passed = runs.filter((r) => r.status === 'success').length;
  const deploys = runs
    .flatMap((r) =>
      r.deploy_id === undefined
        ? []
        : [{ deploy_id: r.deploy_id, message: r.message, finished_at: r.finished_at }],
    )
    .sort((a, b) => (a.finished_at < b.finished_at ? -1 : 1));
  return { total: runs.length, passed, failed: runs.length - passed, deploys };
}

export function registerCiHealth(agent: Agent, tools: ToolClient): void {
  agent.capability('code.ci_health', async (_ctx, rawInput) => {
    const input = rawInput as CiHealthInput;
    const repo = requireRepo(input);
    const windowDays = input.window_days ?? DEFAULT_WINDOW_DAYS;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'window_days must be an integer between 1 and 90',
      );
    }

    const response = await tools.call(CODE_FORGE, 'ci_runs', { repo });
    const data = response.data as { repo: string; as_of: string; runs: CiRun[] };
    const since = windowStart(data.as_of, windowDays);
    const windowed = data.runs.filter((r) => r.finished_at.slice(0, 10) >= since);

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    if (windowed.length === 0) {
      builder.paragraph(`${repo}: no CI runs since ${since}. [${marker}]`);
      return { ...builder.build(response.partial === true ? 0.55 : 0.9) };
    }

    const stats = ciStats(windowed);
    const passRate = ((stats.passed / stats.total) * 100).toFixed(1);
    const runsNoun = stats.total === 1 ? 'CI run' : 'CI runs';
    const deploys =
      stats.deploys.length === 0
        ? ''
        : ` Deploys: ${stats.deploys.map((d) => `${d.deploy_id} (${d.message})`).join(', ')}.`;
    builder.paragraph(
      `${repo}: ${stats.total} ${runsNoun} since ${since} — ${stats.passed} passed, ` +
        `${stats.failed} failed (pass rate ${passRate}%).${deploys} [${marker}]`,
    );
    return { ...builder.build(response.partial === true ? 0.55 : 0.9) };
  });
}
