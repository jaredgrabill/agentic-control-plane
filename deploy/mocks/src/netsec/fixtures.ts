/**
 * netsec fixture loading: the acme-corp firewall ruleset, security groups,
 * IPAM allocations, and vuln-scan findings, each with a Citation-compatible
 * `document` header carrying a fixed lineage_id — document-granularity
 * provenance for network-security answers. Read-only snapshots: v0 has no
 * netsec store, no ledger, no write surface.
 */

import { join } from 'node:path';
import type { Provenance } from '@acp/tool-client';
import { fixturesDir, readJson } from '../cloud/fixtures.js';

export interface FirewallRule {
  rule_id: string;
  ruleset: string;
  service: string;
  direction: 'ingress' | 'egress';
  port: number;
  source_cidr: string;
  action: 'allow' | 'deny';
  description?: string;
}

export interface FirewallRulesFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  rules: FirewallRule[];
}

export interface SecurityGroupRule {
  port: number;
  source_cidr: string;
}

export interface SecurityGroup {
  security_group_id: string;
  service: string;
  ingress: SecurityGroupRule[];
  egress: SecurityGroupRule[];
}

export interface SecurityGroupsFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  groups: SecurityGroup[];
}

export interface IpamAllocation {
  cidr: string;
  service: string;
  zone: 'public' | 'private';
  ips: string[];
}

export interface IpamFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  allocations: IpamAllocation[];
}

export interface VulnFinding {
  image: string;
  service: string;
  cve: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  fixed_version: string;
}

export interface VulnScansFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  findings: VulnFinding[];
}

export interface NetsecFixtures {
  firewallRules: FirewallRulesFixture;
  securityGroups: SecurityGroupsFixture;
  ipam: IpamFixture;
  vulnScans: VulnScansFixture;
}

export function loadNetsecFixtures(dir: string = fixturesDir()): NetsecFixtures {
  return {
    firewallRules: readJson(
      join(dir, 'netsec', 'firewall-rules.json'),
    ) as unknown as FirewallRulesFixture,
    securityGroups: readJson(
      join(dir, 'netsec', 'security-groups.json'),
    ) as unknown as SecurityGroupsFixture,
    ipam: readJson(join(dir, 'netsec', 'ipam.json')) as unknown as IpamFixture,
    vulnScans: readJson(join(dir, 'netsec', 'vuln-scans.json')) as unknown as VulnScansFixture,
  };
}
