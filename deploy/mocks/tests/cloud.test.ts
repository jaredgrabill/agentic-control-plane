import { describe, expect, it } from 'vitest';
import {
  CloudStore,
  costReport,
  createCloudServer,
  loadCloudFixtures,
  searchInventory,
  type CloudResource,
  type CostWeek,
  type QueryOutcome,
} from '../src/index.js';
import { callTool, FIXTURES_DIR } from './support.js';

const fx = loadCloudFixtures(FIXTURES_DIR);

function tagOk(outcome: QueryOutcome): Record<string, unknown> {
  expect(outcome.kind).toBe('ok');
  return (outcome as { kind: 'ok'; data: Record<string, unknown> }).data;
}

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

describe('CloudStore tag writes', () => {
  it('tag_apply returns the previous value of each key (null when absent)', () => {
    const store = new CloudStore(fx);
    const data = tagOk(
      store.tagApply({
        resource_id: 'i-0a1f001',
        tags: { owner: 'team-newowner', cost_center: 'cc-42' },
        idempotency_key: 'tag-apply-1',
      }),
    );
    expect(data.applied).toEqual({ owner: 'team-newowner', cost_center: 'cc-42' });
    // owner pre-existed (platform-oncall) → its previous value; cost_center absent → null.
    expect(data.previous).toEqual({ owner: 'platform-oncall', cost_center: null });
  });

  it('read-your-writes: an applied tag is visible on the next inventory_search', () => {
    const store = new CloudStore(fx);
    store.tagApply({
      resource_id: 'i-0a1f001',
      tags: { owner: 'team-newowner' },
      idempotency_key: 'tag-apply-ryw',
    });
    const found = searchInventory(store.fixtures, { service: 'payments-api', env: 'prod' });
    const resources = (found as { kind: 'ok'; data: { resources: CloudResource[] } }).data
      .resources;
    const target = resources.find((r) => r.resource_id === 'i-0a1f001');
    expect(target?.tags.owner).toBe('team-newowner');
  });

  it('tag_remove reports removed vs absent keys and deletes only present ones', () => {
    const store = new CloudStore(fx);
    const data = tagOk(
      store.tagRemove({
        resource_id: 'i-0a1f001',
        keys: ['owner', 'nonexistent'],
        idempotency_key: 'tag-remove-1',
      }),
    );
    expect(data.removed).toEqual(['owner']);
    expect(data.absent).toEqual(['nonexistent']);
    // owner is gone from the live view.
    const target = store.fixtures.inventory.resources.find((r) => r.resource_id === 'i-0a1f001');
    expect(target?.tags.owner).toBeUndefined();
  });

  it('honest inverse: apply-then-restore returns the resource to its prior tags', () => {
    const store = new CloudStore(fx);
    const before = {
      ...store.fixtures.inventory.resources.find((r) => r.resource_id === 'i-0a1f001')!.tags,
    };
    const applied = tagOk(
      store.tagApply({
        resource_id: 'i-0a1f001',
        tags: { owner: 'team-newowner', added: 'temp' },
        idempotency_key: 'tag-honest-apply',
      }),
    );
    const previous = applied.previous as Record<string, string | null>;
    // Restore = re-apply the keys that had a previous value; remove those absent.
    const restoreApply = Object.fromEntries(
      Object.entries(previous).filter(([, v]) => v !== null),
    ) as Record<string, string>;
    const restoreRemove = Object.entries(previous)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    store.tagApply({
      resource_id: 'i-0a1f001',
      tags: restoreApply,
      idempotency_key: 'tag-honest-restore-a',
    });
    store.tagRemove({
      resource_id: 'i-0a1f001',
      keys: restoreRemove,
      idempotency_key: 'tag-honest-restore-r',
    });
    const after = store.fixtures.inventory.resources.find(
      (r) => r.resource_id === 'i-0a1f001',
    )!.tags;
    expect(after).toEqual(before);
  });

  it('rejects unknown resources, empty/oversized tag sets, and non-string values', () => {
    const store = new CloudStore(fx);
    expect(
      store.tagApply({ resource_id: 'i-ghost', tags: { a: 'b' }, idempotency_key: 'k-ghost-1' })
        .kind,
    ).toBe('not_found');
    expect(
      store.tagApply({ resource_id: 'i-0a1f001', tags: {}, idempotency_key: 'k-empty-01' }).kind,
    ).toBe('invalid_input');
    expect(
      store.tagApply({
        resource_id: 'i-0a1f001',
        tags: { n: 5 as unknown as string },
        idempotency_key: 'k-nonstr-1',
      }).kind,
    ).toBe('invalid_input');
  });

  it('tag_remove rejects unknown resources, empty key lists, and missing idempotency keys', () => {
    const store = new CloudStore(fx);
    expect(
      store.tagRemove({ resource_id: 'i-ghost', keys: ['owner'], idempotency_key: 'k-rm-ghost' })
        .kind,
    ).toBe('not_found');
    expect(
      store.tagRemove({ resource_id: 'i-0a1f001', keys: [], idempotency_key: 'k-rm-empty1' }).kind,
    ).toBe('invalid_input');
    expect(
      store.tagRemove({ resource_id: 'i-0a1f001', keys: ['owner'], idempotency_key: 'no' }).kind,
    ).toBe('invalid_input');
  });

  it('idempotency: replays a stored tag_apply and rejects a key reused with different args', () => {
    const store = new CloudStore(fx);
    const first = store.tagApply({
      resource_id: 'i-0a1f001',
      tags: { owner: 'x' },
      idempotency_key: 'idem-tag-1',
    });
    const replay = store.tagApply({
      resource_id: 'i-0a1f001',
      tags: { owner: 'x' },
      idempotency_key: 'idem-tag-1',
    });
    expect(replay).toEqual(first);
    const conflict = store.tagApply({
      resource_id: 'i-0a1f001',
      tags: { owner: 'y' },
      idempotency_key: 'idem-tag-1',
    });
    expect(conflict.kind).toBe('invalid_input');
  });

  it('dry_run tag_apply validates without mutating or claiming the ledger key', () => {
    const store = new CloudStore(fx);
    const dry = tagOk(
      store.tagApply({
        resource_id: 'i-0a1f001',
        tags: { owner: 'z' },
        idempotency_key: 'dry-tag-1',
        dry_run: true,
      }),
    );
    expect(dry.dry_run).toBe(true);
    const target = store.fixtures.inventory.resources.find((r) => r.resource_id === 'i-0a1f001');
    expect(target?.tags.owner).toBe('platform-oncall');
  });

  it('shares one store across fresh McpServers (apply on one, read-your-writes on the next)', async () => {
    const store = new CloudStore(fx);
    await callTool(createCloudServer(store), 'tag_apply', {
      resource_id: 'i-0a1f001',
      tags: { owner: 'cross-server' },
      idempotency_key: 'cross-tag-1',
    });
    const found = await callTool(createCloudServer(store), 'inventory_search', {
      service: 'payments-api',
      env: 'prod',
    });
    const resources = (found.structuredContent as { data: { resources: CloudResource[] } }).data
      .resources;
    expect(resources.find((r) => r.resource_id === 'i-0a1f001')?.tags.owner).toBe('cross-server');
  });
});
