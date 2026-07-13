/**
 * Pure query functions over the netsec fixtures (no throwing, no mutation).
 * All four are reads: search-by-filter misses answer `ok` with an empty list
 * (so a caller can distinguish "covered but empty" from a direct-reference
 * miss), while a get-by-id miss is a typed not_found. Injection-shaped ids
 * ride as literal strings and simply fail to match.
 */

import type { QueryOutcome } from '../cloud/queries.js';
import type { NetsecFixtures } from './fixtures.js';

const DEFAULT_LIMIT = 20;
const DIRECTIONS = ['ingress', 'egress'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export interface FirewallRulesSearchArgs {
  service?: string | undefined;
  cidr?: string | undefined;
  port?: number | undefined;
  direction?: string | undefined;
  limit?: number | undefined;
}

export function firewallRulesSearch(
  fx: NetsecFixtures,
  args: FirewallRulesSearchArgs,
): QueryOutcome {
  const active =
    args.service !== undefined ||
    args.cidr !== undefined ||
    args.port !== undefined ||
    args.direction !== undefined;
  if (!active) {
    return {
      kind: 'invalid_input',
      message: 'provide at least one filter — unbounded ruleset dumps are not a tool',
    };
  }
  if (args.direction !== undefined && !DIRECTIONS.includes(args.direction)) {
    return { kind: 'invalid_input', message: 'direction must be ingress or egress' };
  }
  const limit = args.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { kind: 'invalid_input', message: 'limit must be an integer between 1 and 50' };
  }

  const matched = fx.firewallRules.rules.filter(
    (r) =>
      (args.service === undefined || r.service === args.service) &&
      (args.cidr === undefined || r.source_cidr === args.cidr) &&
      (args.port === undefined || r.port === args.port) &&
      (args.direction === undefined || r.direction === args.direction),
  );
  return {
    kind: 'ok',
    data: {
      as_of: fx.firewallRules.as_of,
      rules: matched.slice(0, limit),
      total_matched: matched.length,
      truncated: matched.length > limit,
      // Coverage signal for a service filter: false means the ruleset holds
      // NO rules for that service at all — the caller should abstain, not
      // report a confident "no rules".
      ...(args.service === undefined
        ? {}
        : {
            service_covered: fx.firewallRules.rules.some((r) => r.service === args.service),
          }),
    },
  };
}

export interface SecurityGroupGetArgs {
  security_group_id?: string | undefined;
  service?: string | undefined;
}

export function securityGroupGet(fx: NetsecFixtures, args: SecurityGroupGetArgs): QueryOutcome {
  if (args.security_group_id !== undefined) {
    const group = fx.securityGroups.groups.find(
      (g) => g.security_group_id === args.security_group_id,
    );
    if (group === undefined) {
      return {
        kind: 'not_found',
        message: `security group ${args.security_group_id} is not in the security-group snapshot`,
      };
    }
    return { kind: 'ok', data: { as_of: fx.securityGroups.as_of, groups: [group] } };
  }
  const groups =
    args.service === undefined
      ? fx.securityGroups.groups
      : fx.securityGroups.groups.filter((g) => g.service === args.service);
  return { kind: 'ok', data: { as_of: fx.securityGroups.as_of, groups } };
}

export interface IpamLookupArgs {
  cidr?: string | undefined;
  service?: string | undefined;
  ip?: string | undefined;
}

export function ipamLookup(fx: NetsecFixtures, args: IpamLookupArgs): QueryOutcome {
  const allocations = fx.ipam.allocations.filter(
    (a) =>
      (args.cidr === undefined || a.cidr === args.cidr) &&
      (args.service === undefined || a.service === args.service) &&
      (args.ip === undefined || a.ips.includes(args.ip)),
  );
  return { kind: 'ok', data: { as_of: fx.ipam.as_of, allocations } };
}

export interface VulnScanReportArgs {
  service?: string | undefined;
  severity?: string | undefined;
  image?: string | undefined;
}

export function vulnScanReport(fx: NetsecFixtures, args: VulnScanReportArgs): QueryOutcome {
  if (args.severity !== undefined && !SEVERITIES.includes(args.severity)) {
    return {
      kind: 'invalid_input',
      message: 'severity must be one of critical, high, medium, low',
    };
  }
  const findings = fx.vulnScans.findings.filter(
    (f) =>
      (args.service === undefined || f.service === args.service) &&
      (args.severity === undefined || f.severity === args.severity) &&
      (args.image === undefined || f.image === args.image),
  );
  return { kind: 'ok', data: { as_of: fx.vulnScans.as_of, findings } };
}
