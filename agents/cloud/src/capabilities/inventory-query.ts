/**
 * cloud.inventory_query — deterministic, extractive, zero-LLM: one
 * inventory_search call, answer text templated from the tool data, cited
 * against the snapshot document. An empty result is a confident factual
 * answer, never an abstention.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, CLOUD_ESTATE, primaryProvenance } from '../tools.js';

interface InventoryInput {
  service?: string | undefined;
  env?: string | undefined;
  resource_type?: string | undefined;
  region?: string | undefined;
  limit?: number | undefined;
}

interface InventoryResource {
  resource_id: string;
  type: string;
  service: string;
  env: string;
  region: string;
  size: string;
  monthly_cost_usd: number;
  created_at: string;
  tags: Record<string, string>;
}

const FILTER_KEYS = ['service', 'env', 'resource_type', 'region'] as const;

/** `service=payments-api, env=prod` — filters in declaration order. */
export function describeFilters(input: InventoryInput): string {
  return FILTER_KEYS.filter((key) => input[key] !== undefined)
    .map((key) => `${key}=${String(input[key])}`)
    .join(', ');
}

export function formatMoney(amount: number): string {
  return amount.toLocaleString('en-US');
}

/** One resource line; deploy/purpose tags surface so spikes are attributable. */
export function formatResource(resource: InventoryResource): string {
  const deploy =
    resource.tags.deploy_id === undefined ? '' : ` by deploy ${resource.tags.deploy_id}`;
  const purpose = resource.tags.purpose === undefined ? '' : ` (${resource.tags.purpose})`;
  return (
    `${resource.resource_id} — ${resource.type} ${resource.size}, ${resource.service} ` +
    `(${resource.env}, ${resource.region}), $${formatMoney(resource.monthly_cost_usd)}/month, ` +
    `created ${resource.created_at}${deploy}${purpose}`
  );
}

export function registerInventoryQuery(agent: Agent, tools: ToolClient): void {
  agent.capability('cloud.inventory_query', async (ctx, rawInput) => {
    const input = rawInput as InventoryInput;
    if (FILTER_KEYS.every((key) => input[key] === undefined)) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide at least one filter: service, env, resource_type, or region',
      );
    }
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    ) {
      throw new CapabilityError(ErrorClass.NeedsInput, 'limit must be an integer between 1 and 50');
    }

    const response = await tools.call(
      CLOUD_ESTATE,
      'inventory_search',
      { ...input },
      callOptions(ctx),
    );
    const data = response.data as {
      as_of: string;
      resources: InventoryResource[];
      total_matched: number;
      truncated: boolean;
    };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    const confidence = response.partial === true ? 0.55 : 0.9;

    if (data.total_matched === 0) {
      builder.paragraph(
        `No resources match ${describeFilters(input)} in the ${data.as_of} inventory ` +
          `snapshot. [${marker}]`,
      );
      return { ...builder.build(confidence) };
    }

    const plural = data.total_matched === 1 ? 'resource matches' : 'resources match';
    builder.paragraph(
      `${data.total_matched} ${plural} ${describeFilters(input)} in the ` +
        `${data.as_of} inventory snapshot: [${marker}]`,
    );
    builder.paragraph(data.resources.map((r) => `- ${formatResource(r)}`).join('\n'));
    const runRate = data.resources.reduce((sum, r) => sum + r.monthly_cost_usd, 0);
    const truncation = data.truncated
      ? ` Showing the top ${data.resources.length} by monthly cost — narrow the filters for the rest.`
      : '';
    builder.paragraph(`Combined run rate: $${formatMoney(runRate)}/month.${truncation}`);
    return { ...builder.build(confidence) };
  });
}
