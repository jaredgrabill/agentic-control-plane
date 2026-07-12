/**
 * itsm: mock MCP server over the acme-corp change log + calendar. Read tools
 * (change_get R0, calendar_conflicts R0) and governed write tools
 * (change_create_draft R1, change_submit R2, change_withdraw R2). Tool text
 * stays descriptive data — never imperative, model-aimed prose (ASI02).
 *
 * The server is STATELESS across POSTs (a fresh McpServer per request), so all
 * mutable state lives in the ItsmStore passed in — ONE per process, closed
 * over by main.ts. Every handler is a pure map from store outcome to
 * ToolEnvelope; the store owns the state machine, idempotency, and dry_run.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Provenance } from '@acp/tool-client';
import { fail, ok, toCallToolResult } from '../shared/envelope.js';
import { failureEnvelope, forcePartial, type FailureDirective } from '../shared/failure.js';
import type { ItsmFixtures } from './fixtures.js';
import type { ItsmOutcome, ItsmStore } from './store.js';

const windowSchema = z.object({ start: z.string(), end: z.string() });

export function createItsmServer(
  store: ItsmStore,
  fixtures: ItsmFixtures,
  options: { failure?: FailureDirective | undefined } = {},
): McpServer {
  const server = new McpServer({ name: 'itsm', version: '0.1.0' });
  const changeDoc = fixtures.changes.document;
  const calendarDoc = fixtures.calendar.document;

  const respond = (document: Provenance, outcome: ItsmOutcome) => {
    const scripted = failureEnvelope(options.failure);
    if (scripted !== undefined) return toCallToolResult(scripted);
    const envelope =
      outcome.kind === 'ok' ? ok(outcome.data, [document]) : fail(outcome.kind, outcome.message);
    return toCallToolResult(forcePartial(envelope, options.failure));
  };

  server.registerTool(
    'change_get',
    {
      description:
        'Fetch one change record from the change log by its change_id, including status ' +
        '(draft, submitted, withdrawn, closed), service, and maintenance window.',
      inputSchema: { change_id: z.string() },
    },
    (args) => respond(changeDoc, store.changeGet(args)),
  );

  server.registerTool(
    'calendar_conflicts',
    {
      description:
        'List scheduled changes and change-freeze periods that overlap a maintenance window, ' +
        'plus the calendar coverage horizon. Optionally narrow scheduled conflicts to one service.',
      inputSchema: { window: windowSchema, service: z.string().optional() },
    },
    (args) => respond(calendarDoc, store.calendarConflicts(args)),
  );

  server.registerTool(
    'change_create_draft',
    {
      description:
        'Create a draft change record. Returns the assigned change_id and draft status. ' +
        'Idempotency-keyed; dry_run validates without reserving an id.',
      inputSchema: {
        title: z.string().min(8).max(200),
        description: z.string().optional(),
        service: z.string().optional(),
        window: windowSchema.optional(),
        idempotency_key: z.string().min(8).max(128),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => respond(changeDoc, store.createDraft(args)),
  );

  server.registerTool(
    'change_submit',
    {
      description:
        'Submit a draft change for approval. Only a draft change may be submitted; any other ' +
        'status is a typed invalid_input. Idempotency-keyed; dry_run validates without mutating.',
      inputSchema: {
        change_id: z.string(),
        idempotency_key: z.string().min(8).max(128),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => respond(changeDoc, store.submit(args)),
  );

  server.registerTool(
    'change_withdraw',
    {
      description:
        'Withdraw a submitted change. Only a submitted change may be withdrawn; any other ' +
        'status is a typed invalid_input. Idempotency-keyed; dry_run validates without mutating.',
      inputSchema: {
        change_id: z.string(),
        reason: z.string().optional(),
        idempotency_key: z.string().min(8).max(128),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => respond(changeDoc, store.withdraw(args)),
  );

  return server;
}
