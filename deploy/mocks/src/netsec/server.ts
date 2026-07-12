/**
 * netsec: mock MCP server over the acme-corp firewall/security-group/IPAM/
 * vuln-scan fixtures. READ-ONLY: four R0 read tools, no store, no ledger, no
 * idempotency_key or dry_run parameters — there is nothing to mutate. Tool
 * text stays descriptive data — never imperative, model-aimed prose (ASI02).
 *
 * Stateless per POST (a fresh McpServer per request, forge pattern): the
 * injected fixtures are the only data, and they are never written.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fail, ok, toCallToolResult } from '../shared/envelope.js';
import { failureEnvelope, forcePartial, type FailureDirective } from '../shared/failure.js';
import { provenanceOf } from '../cloud/fixtures.js';
import type { QueryOutcome } from '../cloud/queries.js';
import type { NetsecFixtures } from './fixtures.js';
import { firewallRulesSearch, ipamLookup, securityGroupGet, vulnScanReport } from './queries.js';

export function createNetsecServer(
  fx: NetsecFixtures,
  options: { failure?: FailureDirective | undefined } = {},
): McpServer {
  const server = new McpServer({ name: 'netsec', version: '0.1.0' });

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
    'firewall_rules_search',
    {
      description:
        'Firewall rules from the acme ruleset snapshot, filtered by service, source CIDR, ' +
        'port, or direction. Returns matching rules with total and truncation counts, and a ' +
        'coverage flag when filtering by service.',
      inputSchema: {
        service: z.string().optional(),
        cidr: z.string().optional(),
        port: z.number().int().optional(),
        direction: z.enum(['ingress', 'egress']).optional(),
        limit: z.number().int().optional(),
      },
    },
    (args) => respond(fx.firewallRules.document, firewallRulesSearch(fx, args)),
  );

  server.registerTool(
    'security_group_get',
    {
      description:
        'Security groups from the snapshot: one by security_group_id, those attached to a ' +
        'service, or all. Each group lists its ingress and egress rules (port, source CIDR).',
      inputSchema: {
        security_group_id: z.string().optional(),
        service: z.string().optional(),
      },
    },
    (args) => respond(fx.securityGroups.document, securityGroupGet(fx, args)),
  );

  server.registerTool(
    'ipam_lookup',
    {
      description:
        'IP address allocations from the IPAM snapshot, filtered by CIDR block, service, or a ' +
        'specific IP. Each allocation carries its zone (public or private).',
      inputSchema: {
        cidr: z.string().optional(),
        service: z.string().optional(),
        ip: z.string().optional(),
      },
    },
    (args) => respond(fx.ipam.document, ipamLookup(fx, args)),
  );

  server.registerTool(
    'vuln_scan_report',
    {
      description:
        'Vulnerability findings from the latest image scan, filtered by service, severity ' +
        '(critical, high, medium, low), or image. Each finding names the CVE, severity, and ' +
        'fixed version.',
      inputSchema: {
        service: z.string().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        image: z.string().optional(),
      },
    },
    (args) => respond(fx.vulnScans.document, vulnScanReport(fx, args)),
  );

  return server;
}
