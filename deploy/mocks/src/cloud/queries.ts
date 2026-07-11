/**
 * Pure query functions over the cloud fixtures. They never throw — results
 * are a discriminated union the server maps onto ToolEnvelopes, keeping
 * failure semantics on the wire, not in stack traces.
 */

import type { CloudFixtures, CloudResource } from './fixtures.js';

export type QueryOutcome =
  | { kind: 'ok'; data: Record<string, unknown>; partial?: boolean; gaps?: string[] }
  | { kind: 'invalid_input' | 'not_found'; message: string };

export interface InventoryFilters {
  service?: string | undefined;
  env?: string | undefined;
  resource_type?: string | undefined;
  region?: string | undefined;
  limit?: number | undefined;
}

const DEFAULT_LIMIT = 20;

export function searchInventory(fx: CloudFixtures, filters: InventoryFilters): QueryOutcome {
  const active =
    filters.service !== undefined ||
    filters.env !== undefined ||
    filters.resource_type !== undefined ||
    filters.region !== undefined;
  if (!active) {
    return {
      kind: 'invalid_input',
      message: 'provide at least one filter — unbounded inventory dumps are not a tool',
    };
  }
  const limit = filters.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { kind: 'invalid_input', message: 'limit must be an integer between 1 and 50' };
  }

  const matched = fx.inventory.resources
    .filter(
      (r) =>
        (filters.service === undefined || r.service === filters.service) &&
        (filters.env === undefined || r.env === filters.env) &&
        (filters.resource_type === undefined || r.type === filters.resource_type) &&
        (filters.region === undefined || r.region === filters.region),
    )
    .sort((a, b) => b.monthly_cost_usd - a.monthly_cost_usd);

  const resources: CloudResource[] = matched.slice(0, limit);
  return {
    kind: 'ok',
    data: {
      as_of: fx.inventory.as_of,
      resources,
      total_matched: matched.length,
      truncated: matched.length > limit,
    },
  };
}

export interface CostReportArgs {
  service?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
}

export function costReport(fx: CloudFixtures, args: CostReportArgs): QueryOutcome {
  if (args.start !== undefined && args.end !== undefined && args.start > args.end) {
    return {
      kind: 'invalid_input',
      message: `start ${args.start} is after end ${args.end}`,
    };
  }
  if (
    args.service !== undefined &&
    !fx.costs.weeks.some((w) => args.service !== undefined && args.service in w.by_service)
  ) {
    return { kind: 'not_found', message: `service ${args.service} has no cost history` };
  }

  // Default window: every complete week on record.
  const weeks = fx.costs.weeks
    .filter(
      (w) =>
        (args.start === undefined || w.week_start >= args.start) &&
        (args.end === undefined || w.week_start <= args.end),
    )
    .map((w) =>
      args.service === undefined
        ? w
        : { ...w, by_service: { [args.service]: w.by_service[args.service] ?? 0 } },
    );

  const partial = args.end !== undefined && args.end > fx.costs.complete_through;
  const outcome: QueryOutcome = {
    kind: 'ok',
    data: {
      currency: fx.costs.currency,
      complete_through: fx.costs.complete_through,
      weeks,
    },
  };
  if (partial) {
    outcome.partial = true;
    outcome.gaps = [
      `billing data after ${fx.costs.complete_through} has not landed (T+2 export lag)`,
    ];
  }
  return outcome;
}
