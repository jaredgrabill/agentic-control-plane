/**
 * cloud.cost_analysis — deterministic week-over-week spend analysis.
 *
 * Service mode (input.service set): one cost_report call, latest complete
 * week vs the prior one, spike-or-quiet sentence.
 *
 * Spike mode (no service): cost_report for the totals, then — when the total
 * moved more than the threshold — a second inventory_search call on the top
 * contributor to attribute the spike to concrete resources (deploy tags).
 *
 * All numbers and dates come from tool data (complete_through, week_start),
 * never the wall clock. Partial billing windows drop confidence to 0.55 and
 * say so; abstention is never used.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { CallOptions, ToolClient, ToolResponse } from '@acp/tool-client';
import { callOptions, CLOUD_ESTATE, primaryProvenance } from '../tools.js';
import { formatMoney } from './inventory-query.js';

const DEFAULT_THRESHOLD_PCT = 20;

interface CostAnalysisInput {
  service?: string | undefined;
  period?: { start: string; end: string } | undefined;
  threshold_pct?: number | undefined;
}

export interface CostWeek {
  week_start: string;
  by_service: Record<string, number>;
  total: number;
}

/** Percent change from previous to current (e.g. 13940 → 18120 = 29.99…). */
export function pct(current: number, previous: number): number {
  return ((current - previous) / previous) * 100;
}

/** The comparison pair: the latest week on record and the one before it. */
function lastTwoWeeks(weeks: CostWeek[]): { latest: CostWeek; prior: CostWeek } {
  const latest = weeks[weeks.length - 1];
  const prior = weeks[weeks.length - 2];
  if (latest === undefined || prior === undefined) {
    // Handlers gate on weeks.length >= 2 before calling; this guards the
    // exported helpers used directly in tests.
    throw new Error('week-over-week comparison requires at least two weeks');
  }
  return { latest, prior };
}

/** Latest-vs-prior delta for one series accessor over the report weeks. */
export function weekDelta(
  weeks: CostWeek[],
  valueOf: (week: CostWeek) => number,
): { current: number; previous: number; deltaPct: number; weekStart: string } {
  const { latest, prior } = lastTwoWeeks(weeks);
  const current = valueOf(latest);
  const previous = valueOf(prior);
  return { current, previous, deltaPct: pct(current, previous), weekStart: latest.week_start };
}

/** The service with the largest absolute dollar move week-over-week. */
export function topContributor(weeks: CostWeek[]): {
  service: string;
  deltaUsd: number;
  deltaPct: number;
} {
  const { latest, prior } = lastTwoWeeks(weeks);
  let top: { service: string; deltaUsd: number; deltaPct: number } | undefined;
  for (const [service, current] of Object.entries(latest.by_service)) {
    const previous = prior.by_service[service] ?? 0;
    const deltaUsd = current - previous;
    if (top === undefined || Math.abs(deltaUsd) > Math.abs(top.deltaUsd)) {
      top = { service, deltaUsd, deltaPct: previous === 0 ? 100 : pct(current, previous) };
    }
  }
  if (top === undefined) {
    throw new Error('the cost report names no services');
  }
  return top;
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function registerCostAnalysis(agent: Agent, tools: ToolClient): void {
  agent.capability('cloud.cost_analysis', async (ctx, rawInput) => {
    const input = rawInput as CostAnalysisInput;
    if (input.period !== undefined) {
      if (typeof input.period.start !== 'string' || typeof input.period.end !== 'string') {
        throw new CapabilityError(
          ErrorClass.NeedsInput,
          'period requires both start and end dates (YYYY-MM-DD)',
        );
      }
      if (input.period.start > input.period.end) {
        throw new CapabilityError(
          ErrorClass.NeedsInput,
          'period.start must not be after period.end',
        );
      }
    }
    const threshold = input.threshold_pct ?? DEFAULT_THRESHOLD_PCT;
    if (typeof threshold !== 'number' || threshold < 1 || threshold > 100) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'threshold_pct must be a number between 1 and 100',
      );
    }

    const report = await tools.call(
      CLOUD_ESTATE,
      'cost_report',
      {
        ...(input.service !== undefined ? { service: input.service } : {}),
        ...(input.period !== undefined ? { start: input.period.start, end: input.period.end } : {}),
      },
      callOptions(ctx),
    );
    const data = report.data as {
      currency: string;
      complete_through: string;
      weeks: CostWeek[];
    };
    if (data.weeks.length < 2) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'the requested period covers fewer than two complete weeks — widen it for a ' +
          'week-over-week comparison',
      );
    }

    const builder = agent.answerBuilder();
    const costMarker = builder.cite(primaryProvenance(report));

    const service = input.service;
    if (service === undefined) {
      await analyseTotals(builder, costMarker, data.weeks, threshold, tools, callOptions(ctx));
    } else {
      const delta = weekDelta(data.weeks, (w) => w.by_service[service] ?? 0);
      if (Math.abs(delta.deltaPct) >= threshold) {
        builder.paragraph(
          `${service} spend ${delta.deltaPct >= 0 ? 'rose' : 'fell'} ` +
            `${Math.abs(delta.deltaPct).toFixed(1)}% ($${formatMoney(delta.previous)} → ` +
            `$${formatMoney(delta.current)}) in the week of ${delta.weekStart} — above the ` +
            `${threshold}% threshold. [${costMarker}]`,
        );
      } else {
        builder.paragraph(
          `${service} spend changed ${signedPct(delta.deltaPct)} week-over-week — ` +
            `below the ${threshold}% threshold; no anomaly. [${costMarker}]`,
        );
      }
    }

    if (report.partial === true) {
      builder.paragraph(
        `Cost data after ${data.complete_through} is incomplete (billing export lag); ` +
          'the current week is excluded.',
      );
    }
    return { ...builder.build(report.partial === true ? 0.55 : 0.9) };
  });

  async function analyseTotals(
    builder: ReturnType<Agent['answerBuilder']>,
    costMarker: number,
    weeks: CostWeek[],
    threshold: number,
    tools: ToolClient,
    options: CallOptions,
  ): Promise<void> {
    const total = weekDelta(weeks, (w) => w.total);
    if (Math.abs(total.deltaPct) < threshold) {
      builder.paragraph(
        `Weekly spend changed ${signedPct(total.deltaPct)} ($${formatMoney(total.previous)} → ` +
          `$${formatMoney(total.current)}) in the week of ${total.weekStart} — below the ` +
          `${threshold}% threshold; no anomaly. [${costMarker}]`,
      );
      return;
    }

    builder.paragraph(
      `Weekly spend ${total.deltaPct >= 0 ? 'rose' : 'fell'} ` +
        `${Math.abs(total.deltaPct).toFixed(1)}% ($${formatMoney(total.previous)} → ` +
        `$${formatMoney(total.current)}) in the week of ${total.weekStart}. [${costMarker}]`,
    );

    const top = topContributor(weeks);
    const inventory = await tools.call(
      CLOUD_ESTATE,
      'inventory_search',
      { service: top.service, env: 'prod' },
      options,
    );
    const contribution =
      `${top.service} (${top.deltaUsd >= 0 ? '+' : '-'}$${formatMoney(Math.abs(top.deltaUsd))}, ` +
      `${signedPct(top.deltaPct)}) is the dominant contributor`;
    const created = resourcesCreatedIn(inventory, total.weekStart);
    const first = created[0];
    if (first !== undefined) {
      const invMarker = builder.cite(primaryProvenance(inventory));
      const deploy = first.tags.deploy_id === undefined ? '' : ` by deploy ${first.tags.deploy_id}`;
      const purpose = first.tags.purpose === undefined ? '' : ` (${first.tags.purpose})`;
      builder.paragraph(
        `${contribution}: ${created.length} ${first.size} instances created ` +
          `${first.created_at}${deploy}${purpose}. [${costMarker}][${invMarker}]`,
      );
    } else {
      builder.paragraph(`${contribution}. [${costMarker}]`);
    }
  }
}

interface CreatedResource {
  size: string;
  created_at: string;
  tags: Record<string, string>;
}

/** Resources whose created_at falls inside the spike week [start, start+6]. */
function resourcesCreatedIn(inventory: ToolResponse, weekStart: string): CreatedResource[] {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekEnd = end.toISOString().slice(0, 10);
  const resources = (inventory.data.resources ?? []) as CreatedResource[];
  return resources.filter((r) => r.created_at >= weekStart && r.created_at <= weekEnd);
}
