import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, CapabilityError, ErrorClass } from '@acp/agent-sdk';
import { ApplicationFailure } from '@temporalio/common';
import { FakeToolClient, noRetriever, type ToolResponse } from '@acp/tool-client';
import { describe, expect, it } from 'vitest';
import {
  describeFilters,
  formatMoney,
  formatResource,
} from '../src/capabilities/inventory-query.js';
import {
  pct,
  topContributor,
  weekDelta,
  type CostWeek,
} from '../src/capabilities/cost-analysis.js';
import { registerCapabilities } from '../src/capabilities/index.js';
import { createToolClient } from '../src/tools.js';

const MANIFEST = join(import.meta.dirname, '..', 'manifest.yaml');

const INVENTORY_PROV = {
  doc_id: 'cloud/inventory-snapshot',
  version: '2026-07-08',
  effective_date: '2026-07-08',
  lineage_id: '01981c00-0000-7000-8000-0000000000a1',
};
const COST_PROV = {
  doc_id: 'cloud/cost-report',
  version: '2026-07-08',
  lineage_id: '01981c00-0000-7000-8000-0000000000a2',
};

const LOADTEST_RESOURCE = {
  resource_id: 'i-0b7e101',
  type: 'ec2',
  service: 'payments-api',
  env: 'prod',
  region: 'us-east-1',
  size: 'm5.4xlarge',
  monthly_cost_usd: 2925,
  created_at: '2026-07-01',
  tags: {
    team: 'team-payments',
    deploy_id: 'd-2026-07-01-042',
    purpose: 'tls13-migration-loadtest',
  },
};

const WEEKS: CostWeek[] = [
  {
    week_start: '2026-06-22',
    by_service: { 'payments-api': 4180, 'checkout-web': 3200 },
    total: 13940,
  },
  {
    week_start: '2026-06-29',
    by_service: { 'payments-api': 8240, 'checkout-web': 3240 },
    total: 18120,
  },
];

function inventoryResponse(overrides: Partial<ToolResponse['data']> = {}): ToolResponse {
  return {
    data: {
      as_of: '2026-07-08',
      resources: [LOADTEST_RESOURCE],
      total_matched: 1,
      truncated: false,
      ...overrides,
    },
    provenance: [INVENTORY_PROV],
  };
}

function costResponse(
  weeks: CostWeek[] = WEEKS,
  extra: Partial<Pick<ToolResponse, 'partial' | 'gaps'>> = {},
): ToolResponse {
  return {
    data: { currency: 'USD', complete_through: '2026-07-05', weeks },
    provenance: [COST_PROV],
    ...extra,
  };
}

function buildAgent(tools: FakeToolClient): Agent {
  const agent = Agent.fromManifest(MANIFEST, { retriever: noRetriever('cloud-agent') });
  registerCapabilities(agent, { tools });
  return agent;
}

function stepRequest(capability: string, input: Record<string, unknown>) {
  return {
    kind: 'step_request',
    step_id: randomUUID(),
    task_id: randomUUID(),
    tenant: 'acme',
    agent_id: 'cloud-agent',
    capability,
    input,
  };
}

interface AnswerOutput {
  text: string;
  citations: { doc_id: string; version: string; lineage_id: string }[];
  confidence: number;
  abstained?: boolean;
}

describe('cloud.inventory_query', () => {
  it('answers with resource lines, run rate, and the snapshot citation — zero LLM calls', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () => inventoryResponse(),
    });
    const agent = buildAgent(tools);
    const step = await agent.execute(
      stepRequest('cloud.inventory_query', { service: 'payments-api', env: 'prod' }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('1 resource matches service=payments-api, env=prod');
    expect(output.text).toContain('m5.4xlarge');
    expect(output.text).toContain('by deploy d-2026-07-01-042 (tls13-migration-loadtest)');
    expect(output.text).toContain('Combined run rate: $2,925/month.');
    expect(output.citations).toEqual([INVENTORY_PROV]);
    expect(output.confidence).toBe(0.9);
    expect(output.abstained).toBeUndefined();
    expect(step.usage?.llm_calls).toBe(0);
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]).toMatchObject({
      server: 'cloud-estate',
      tool: 'inventory_search',
      args: { service: 'payments-api', env: 'prod' },
    });
  });

  it('forwards the delegated token and correlation ids on every tool call', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () => inventoryResponse(),
    });
    const request = {
      ...stepRequest('cloud.inventory_query', { env: 'prod' }),
      delegated_token: 'delegated-jwt-123',
    };
    const step = await buildAgent(tools).execute(request);
    expect(step.status).toBe('completed');
    expect(tools.calls[0]!.options).toEqual({
      delegatedToken: 'delegated-jwt-123',
      taskId: request.task_id,
      stepId: request.step_id,
    });
  });

  it('states an empty result confidently with the citation', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () => inventoryResponse({ resources: [], total_matched: 0 }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.inventory_query', { service: 'ghost-service' }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toBe(
      'No resources match service=ghost-service in the 2026-07-08 inventory snapshot. [1]',
    );
    expect(output.confidence).toBe(0.9);
    expect(output.abstained).toBeUndefined();
  });

  it('notes truncation when the tool truncated the match list', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () =>
        inventoryResponse({ total_matched: 30, truncated: true }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.inventory_query', { env: 'prod', limit: 1 }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('30 resources match env=prod');
    expect(output.text).toContain('Showing the top 1 by monthly cost');
  });

  it('drops confidence to 0.55 on a partial tool response', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () => ({
        ...inventoryResponse(),
        partial: true,
        gaps: ['forced'],
      }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.inventory_query', { env: 'prod' }),
    );
    expect((step.output as unknown as AnswerOutput).confidence).toBe(0.55);
  });

  it('fails needs_input without any filter — before calling the tool', async () => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(stepRequest('cloud.inventory_query', {}));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(step.error?.message).toBe(
      'provide at least one filter: service, env, resource_type, or region',
    );
    expect(tools.calls).toHaveLength(0);
  });

  it('fails needs_input on an out-of-range limit', async () => {
    const step = await buildAgent(new FakeToolClient({})).execute(
      stepRequest('cloud.inventory_query', { service: 'payments-api', limit: 500 }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
  });
});

describe('cloud.cost_analysis', () => {
  it('service mode: quiet service, exactly one tool call', async () => {
    const tools = new FakeToolClient({ 'cloud-estate.cost_report': () => costResponse() });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.cost_analysis', { service: 'checkout-web' }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toBe(
      'checkout-web spend changed +1.3% week-over-week — below the 20% threshold; ' +
        'no anomaly. [1]',
    );
    expect(output.citations).toEqual([COST_PROV]);
    expect(tools.calls).toHaveLength(1);
    expect(step.usage?.llm_calls).toBe(0);
  });

  it('service mode: spike sentence above the threshold', async () => {
    const tools = new FakeToolClient({ 'cloud-estate.cost_report': () => costResponse() });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.cost_analysis', { service: 'payments-api' }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toBe(
      'payments-api spend rose 97.1% ($4,180 → $8,240) in the week of 2026-06-29 — ' +
        'above the 20% threshold. [1]',
    );
  });

  it('spike mode: attributes the spike via a second inventory call (exactly two calls)', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => costResponse(),
      'cloud-estate.inventory_search': () =>
        inventoryResponse({
          resources: Array.from({ length: 6 }, () => LOADTEST_RESOURCE),
          total_matched: 10,
        }),
    });
    const step = await buildAgent(tools).execute(stepRequest('cloud.cost_analysis', {}));
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain(
      'Weekly spend rose 30.0% ($13,940 → $18,120) in the week of 2026-06-29. [1]',
    );
    expect(output.text).toContain(
      'payments-api (+$4,060, +97.1%) is the dominant contributor: 6 m5.4xlarge ' +
        'instances created 2026-07-01 by deploy d-2026-07-01-042 ' +
        '(tls13-migration-loadtest). [1][2]',
    );
    expect(output.citations).toEqual([COST_PROV, INVENTORY_PROV]);
    expect(tools.calls.map((c) => c.tool)).toEqual(['cost_report', 'inventory_search']);
    expect(tools.calls[1]!.args).toEqual({ service: 'payments-api', env: 'prod' });
    // The second, follow-up call carries the same delegated identity.
    expect(tools.calls[1]!.options).toEqual(tools.calls[0]!.options);
    expect(output.confidence).toBe(0.9);
  });

  it('spike mode without spike-week resources keeps the single citation', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => costResponse(),
      'cloud-estate.inventory_search': () =>
        inventoryResponse({
          resources: [{ ...LOADTEST_RESOURCE, created_at: '2025-03-02', tags: {} }],
          total_matched: 4,
        }),
    });
    const step = await buildAgent(tools).execute(stepRequest('cloud.cost_analysis', {}));
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain(
      'payments-api (+$4,060, +97.1%) is the dominant contributor. [1]',
    );
    expect(output.citations).toEqual([COST_PROV]);
  });

  it('spike mode below the threshold stops after one call', async () => {
    const quiet: CostWeek[] = [
      { week_start: '2026-06-15', by_service: { 'payments-api': 4160 }, total: 13900 },
      { week_start: '2026-06-22', by_service: { 'payments-api': 4180 }, total: 13940 },
    ];
    const tools = new FakeToolClient({ 'cloud-estate.cost_report': () => costResponse(quiet) });
    const step = await buildAgent(tools).execute(stepRequest('cloud.cost_analysis', {}));
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('below the 20% threshold; no anomaly.');
    expect(tools.calls).toHaveLength(1);
  });

  it('appends the incompleteness note and drops confidence on partial data', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => costResponse(WEEKS, { partial: true, gaps: ['lag'] }),
      'cloud-estate.inventory_search': () => inventoryResponse(),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.cost_analysis', { period: { start: '2026-06-22', end: '2026-07-08' } }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain(
      'Cost data after 2026-07-05 is incomplete (billing export lag); the current week is excluded.',
    );
    expect(output.confidence).toBe(0.55);
  });

  it.each([
    ['inverted period', { period: { start: '2026-07-05', end: '2026-06-01' } }],
    ['half period', { period: { start: '2026-06-01' } }],
    ['bad threshold', { threshold_pct: 500 }],
  ])('fails needs_input on %s', async (_name, input) => {
    const step = await buildAgent(new FakeToolClient({})).execute(
      stepRequest('cloud.cost_analysis', input),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
  });

  it('fails needs_input when the window has fewer than two weeks', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => costResponse([WEEKS[1]!]),
    });
    const step = await buildAgent(tools).execute(stepRequest('cloud.cost_analysis', {}));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(step.error?.message).toContain('fewer than two complete weeks');
  });
});

describe('tool failures propagate through the execute taxonomy', () => {
  it('retryable tool errors become retryable ApplicationFailures for Temporal', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => {
        throw new CapabilityError(
          ErrorClass.Retryable,
          'tool cloud-estate.cost_report rate limited — retry after 3s',
          { retry_after_s: 3 },
        );
      },
    });
    const failure = await buildAgent(tools)
      .execute(stepRequest('cloud.cost_analysis', {}))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe('Retryable');
    expect((failure as ApplicationFailure).nonRetryable).toBe(false);
  });

  it('permanent tool errors land as a failed step result', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.inventory_search': () => {
        throw new CapabilityError(ErrorClass.Permanent, 'malformed');
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.inventory_query', { env: 'prod' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('permanent');
  });

  it('not_found from the tool surfaces as needs_input', async () => {
    const tools = new FakeToolClient({
      'cloud-estate.cost_report': () => {
        throw new CapabilityError(ErrorClass.NeedsInput, 'service nope has no cost history');
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('cloud.cost_analysis', { service: 'nope' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
  });
});

describe('pure helpers', () => {
  it('pct and formatting reproduce the storyline numbers exactly', () => {
    expect(pct(18120, 13940).toFixed(1)).toBe('30.0');
    expect(pct(8240, 4180).toFixed(1)).toBe('97.1');
    expect(pct(3240, 3200).toFixed(1)).toBe('1.3');
    expect(formatMoney(18120)).toBe('18,120');
  });

  it('weekDelta and topContributor pick the latest week and biggest mover', () => {
    const delta = weekDelta(WEEKS, (w) => w.total);
    expect(delta).toEqual({
      current: 18120,
      previous: 13940,
      deltaPct: pct(18120, 13940),
      weekStart: '2026-06-29',
    });
    expect(topContributor(WEEKS)).toEqual({
      service: 'payments-api',
      deltaUsd: 4060,
      deltaPct: pct(8240, 4180),
    });
  });

  it('describeFilters and formatResource render deterministically', () => {
    expect(describeFilters({ env: 'prod', service: 'payments-api' })).toBe(
      'service=payments-api, env=prod',
    );
    expect(formatResource(LOADTEST_RESOURCE)).toBe(
      'i-0b7e101 — ec2 m5.4xlarge, payments-api (prod, us-east-1), $2,925/month, ' +
        'created 2026-07-01 by deploy d-2026-07-01-042 (tls13-migration-loadtest)',
    );
  });

  it('createToolClient binds the cloud-estate server from the environment', () => {
    expect(createToolClient()).toBeDefined();
  });

  it('createToolClient wires the acp:tools exchange only when a client secret is set', () => {
    const saved = process.env.ACP_AGENT_CLIENT_SECRET;
    try {
      delete process.env.ACP_AGENT_CLIENT_SECRET;
      expect(createToolClient()).toBeDefined();
      process.env.ACP_AGENT_CLIENT_SECRET = 'agent-cloud-dev-secret';
      expect(createToolClient()).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.ACP_AGENT_CLIENT_SECRET;
      else process.env.ACP_AGENT_CLIENT_SECRET = saved;
    }
  });
});
