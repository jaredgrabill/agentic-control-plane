/**
 * cloud-estate: mock MCP server over the acme-corp cloud fixtures.
 * Read tools: inventory_search, cost_report (R0). Write tools: tag_apply,
 * tag_remove (R2, scope cloud:tag:write). Tool text stays descriptive data —
 * never imperative, model-aimed prose (ASI02).
 *
 * State (applied/removed tags, idempotency ledger) lives in the CloudStore
 * passed in — ONE per process, closed over by main.ts — so writes survive the
 * fresh-McpServer-per-POST door and later reads see them. Callers may pass a
 * plain CloudFixtures for a stateless (read-only) server; a fresh store is
 * wrapped around it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail, ok, toCallToolResult } from '../shared/envelope.js';
import { failureEnvelope, forcePartial, type FailureDirective } from '../shared/failure.js';
import { provenanceOf, type CloudFixtures } from './fixtures.js';
import { costReport, searchInventory, type QueryOutcome } from './queries.js';
import { CloudStore } from './store.js';

export function createCloudServer(
  source: CloudFixtures | CloudStore,
  options: { failure?: FailureDirective | undefined } = {},
): McpServer {
  const store = source instanceof CloudStore ? source : new CloudStore(source);
  const fx = store.fixtures;
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

  server.registerTool(
    'tag_apply',
    {
      description:
        'Set tags on an inventory resource. Returns the previous value of each key ' +
        '(null when the key was absent) so the change is reversible. Idempotency-keyed; ' +
        'dry_run validates without mutating.',
      inputSchema: {
        resource_id: z.string(),
        tags: z.record(z.string()),
        idempotency_key: z.string().min(8).max(128),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => respond(fx.inventory.document, store.tagApply(args)),
  );

  server.registerTool(
    'tag_remove',
    {
      description:
        'Remove tags from an inventory resource by key. Removing an absent key is not an ' +
        'error (it is reported under absent). Idempotency-keyed; dry_run validates without mutating.',
      inputSchema: {
        resource_id: z.string(),
        keys: z.array(z.string()),
        idempotency_key: z.string().min(8).max(128),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => respond(fx.inventory.document, store.tagRemove(args)),
  );

  return server;
}
