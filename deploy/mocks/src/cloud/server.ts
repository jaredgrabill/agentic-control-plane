/**
 * cloud-estate: mock MCP server over the acme-corp cloud fixtures.
 * Tools: inventory_search, cost_report. Tool text stays descriptive data —
 * never imperative, model-aimed prose (ASI02).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail, ok, toCallToolResult } from '../shared/envelope.js';
import { failureEnvelope, forcePartial, type FailureDirective } from '../shared/failure.js';
import { provenanceOf, type CloudFixtures } from './fixtures.js';
import { costReport, searchInventory, type QueryOutcome } from './queries.js';

export function createCloudServer(
  fx: CloudFixtures,
  options: { failure?: FailureDirective | undefined } = {},
): McpServer {
  const server = new McpServer({ name: 'cloud-estate', version: '0.1.0' });

  const respond = (document: Parameters<typeof provenanceOf>[0], outcome: QueryOutcome) => {
    const scripted = failureEnvelope(options.failure);
    if (scripted !== undefined) return toCallToolResult(scripted);
    const envelope =
      outcome.kind === 'ok'
        ? ok(outcome.data, provenanceOf(document), {
            ...(outcome.partial !== undefined ? { partial: outcome.partial } : {}),
            ...(outcome.gaps !== undefined ? { gaps: outcome.gaps } : {}),
          })
        : fail(outcome.kind, outcome.message);
    return toCallToolResult(forcePartial(envelope, options.failure));
  };

  server.registerTool(
    'inventory_search',
    {
      description:
        'Search the cloud inventory snapshot. At least one filter is required; ' +
        'results sort by monthly cost descending.',
      inputSchema: {
        service: z.string().optional(),
        env: z.enum(['prod', 'staging', 'dev']).optional(),
        resource_type: z.string().optional(),
        region: z.string().optional(),
        limit: z.number().int().optional(),
      },
    },
    (args) => respond(fx.inventory.document, searchInventory(fx, args)),
  );

  server.registerTool(
    'cost_report',
    {
      description:
        'Weekly spend by service from the billing export. Defaults to every ' +
        'complete week on record; data lands with a T+2 lag.',
      inputSchema: {
        service: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      },
    },
    (args) => respond(fx.costs.document, costReport(fx, args)),
  );

  return server;
}
