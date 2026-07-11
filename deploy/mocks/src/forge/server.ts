/**
 * code-forge: mock MCP server over the acme-corp code fixtures.
 * Tools: repo_dependencies, ci_runs. Aggregation (pass rates, windows from
 * as_of) is capability logic — the tools return raw records.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail, ok, toCallToolResult } from '../shared/envelope.js';
import { failureEnvelope, forcePartial, type FailureDirective } from '../shared/failure.js';
import { provenanceOf } from '../cloud/fixtures.js';
import type { QueryOutcome } from '../cloud/queries.js';
import type { ForgeFixtures } from './fixtures.js';
import { ciRuns, repoDependencies } from './queries.js';

export function createForgeServer(
  fx: ForgeFixtures,
  options: { failure?: FailureDirective | undefined } = {},
): McpServer {
  const server = new McpServer({ name: 'code-forge', version: '0.1.0' });

  const respond = (document: Parameters<typeof provenanceOf>[0], outcome: QueryOutcome) => {
    const scripted = failureEnvelope(options.failure);
    if (scripted !== undefined) return toCallToolResult(scripted);
    const envelope =
      outcome.kind === 'ok'
        ? ok(outcome.data, provenanceOf(document))
        : fail(outcome.kind, outcome.message);
    return toCallToolResult(forcePartial(envelope, options.failure));
  };

  server.registerTool(
    'repo_dependencies',
    {
      description:
        'Dependency edges for a repo: direct or transitive dependencies, or the ' +
        'repos that depend on it.',
      inputSchema: {
        repo: z.string(),
        direction: z.enum(['dependencies', 'dependents']).optional(),
        transitive: z.boolean().optional(),
      },
    },
    (args) => respond(fx.dependencies.document, repoDependencies(fx, args)),
  );

  server.registerTool(
    'ci_runs',
    {
      description: 'CI runs for a repo, newest first, optionally windowed by date.',
      inputSchema: {
        repo: z.string(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    (args) => respond(fx.ciRuns.document, ciRuns(fx, args)),
  );

  return server;
}
