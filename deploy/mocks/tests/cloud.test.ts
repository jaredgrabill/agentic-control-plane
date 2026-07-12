import { describe, expect, it } from 'vitest';
import {
  costReport,
  createCloudServer,
  loadCloudFixtures,
  searchInventory,
  type CloudResource,
  type CostWeek,
} from '../src/index.js';
import { callTool, FIXTURES_DIR } from './support.js';

const fx = loadCloudFixtures(FIXTURES_DIR);

function okData(outcome: ReturnType<typeof searchInventory>): Record<string, unknown> {
  expect(outcome.kind).toBe('ok');
  return (outcome as { kind: 'ok'; data: Record<string, unknown> }).data;
}

describe('searchInventory', () => {
  it('requires at least one filter (limit alone does not count)', () => {
    expect(searchInventory(fx, {})).toEqual({
      kind: 'invalid_input',
      message: 'provide at least one filter — unbounded inventory dumps are not a tool',
    });
    expect(searchInventory(fx, { limit: 10 }).kind).toBe('invalid_input');
  });

  it('rejects out-of-range limits', () => {
    expect(searchInventory(fx, { service: 'payments-api', limit: 0 }).kind).toBe('invalid_input');
    expect(searchInventory(fx, { service: 'payments-api', limit: 51 }).kind).toBe('invalid_input');
    expect(searchInventory(fx, { service: 'payments-api', limit: 2.5 }).kind).toBe('invalid_input');
  });

  it('applies every filter conjunctively and sorts by monthly cost descending', () => {
    const data = okData(searchInventory(fx, { service: 'payments-api', env: 'prod' }));
    const resources = data.resources as CloudResource[];
    expect(data.total_matched).toBe(10);
    expect(data.truncated).toBe(false);
    expect(data.as_of).toBe('2026-07-08');
    expect(resources.slice(0, 6).every((r) => r.size === 'm5.4xlarge')).toBe(true);
    expect(resources[0]!.monthly_cost_usd).toBeGreaterThanOrEqual(resources[9]!.monthly_cost_usd);
  });

  it('truncates to the limit and flags it', () => {
    const data = okData(searchInventory(fx, { env: 'prod', limit: 5 }));
    expect((data.resources as CloudResource[]).length).toBe(5);
    expect(data.total_matched).toBeGreaterThan(5);
    expect(data.truncated).toBe(true);
  });

  it('matches resource_type and region filters', () => {
    const rds = okData(searchInventory(fx, { resource_type: 'rds.instance' }));
    expect((rds.resources as CloudResource[]).every((r) => r.type === 'rds.instance')).toBe(true);
    const region = okData(searchInventory(fx, { region: 'us-east-1', env: 'staging' }));
    expect(region.total_matched).toBe(3);
  });
});

describe('costReport', () => {
  it('defaults to every complete week on record', () => {
    const data = okData(costReport(fx, {}));
    const weeks = data.weeks as CostWeek[];
    expect(weeks.map((w) => w.week_start)).toEqual([
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ]);
    expect(weeks[3]!.total).toBe(18120);
    expect(data.complete_through).toBe('2026-07-05');
  });

  it('filters by_service down to the requested service, totals untouched', () => {
    const data = okData(costReport(fx, { service: 'checkout-web' }));
    const weeks = data.weeks as CostWeek[];
    expect(weeks[3]!.by_service).toEqual({ 'checkout-web': 3240 });
    expect(weeks[3]!.total).toBe(18120);
  });

  it('windows by week_start', () => {
    const data = okData(costReport(fx, { start: '2026-06-22', end: '2026-06-29' }));
    expect((data.weeks as CostWeek[]).map((w) => w.week_start)).toEqual([
      '2026-06-22',
      '2026-06-29',
    ]);
  });

  it('marks windows past complete_through partial with the export-lag gap', () => {
    const outcome = costReport(fx, { start: '2026-06-22', end: '2026-07-08' });
    expect(outcome.kind).toBe('ok');
    const partial = outcome as { kind: 'ok'; partial?: boolean; gaps?: string[] };
    expect(partial.partial).toBe(true);
    expect(partial.gaps).toEqual(['billing data after 2026-07-05 has not landed (T+2 export lag)']);
  });

  it('rejects inverted periods and unknown services with typed outcomes', () => {
    expect(costReport(fx, { start: '2026-07-01', end: '2026-06-01' })).toEqual({
      kind: 'invalid_input',
      message: 'start 2026-07-01 is after end 2026-06-01',
    });
    expect(costReport(fx, { service: 'ghost' })).toEqual({
      kind: 'not_found',
      message: 'service ghost has no cost history',
    });
  });
});

describe('cloud-estate MCP round trips', () => {
  it('serves envelopes in structuredContent with the snapshot provenance', async () => {
    const result = await callTool(createCloudServer(fx), 'inventory_search', {
      service: 'payments-api',
      env: 'prod',
    });
    expect(result.isError).toBe(false);
    const envelope = result.structuredContent as {
      ok: boolean;
      data: { total_matched: number };
      provenance: { doc_id: string; version: string; lineage_id: string }[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.total_matched).toBe(10);
    expect(envelope.provenance).toEqual([fx.inventory.document]);
  });

  it('rate_limited:3 directive replaces every result with a typed failure', async () => {
    const server = createCloudServer(fx, {
      failure: { kind: 'rate_limited', retryAfterS: 3 },
    });
    const result = await callTool(server, 'cost_report', {});
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      ok: boolean;
      error: { code: string; retry_after_s: number };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('rate_limited');
    expect(envelope.error.retry_after_s).toBe(3);
  });

  it('partial directive forces a partial success', async () => {
    const server = createCloudServer(fx, { failure: { kind: 'partial' } });
    const result = await callTool(server, 'cost_report', {});
    const envelope = result.structuredContent as {
      ok: boolean;
      partial?: boolean;
      gaps?: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.partial).toBe(true);
    expect(envelope.gaps).toContain('mock failure directive: partial result forced');
  });

  it('typed failures ride isError with the envelope intact', async () => {
    const result = await callTool(createCloudServer(fx), 'inventory_search', {});
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('invalid_input');
  });
});
