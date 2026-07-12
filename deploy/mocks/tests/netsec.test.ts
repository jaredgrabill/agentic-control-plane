import { describe, expect, it } from 'vitest';
import {
  createNetsecServer,
  firewallRulesSearch,
  ipamLookup,
  loadNetsecFixtures,
  securityGroupGet,
  vulnScanReport,
  type FirewallRule,
  type IpamAllocation,
  type SecurityGroup,
  type VulnFinding,
} from '../src/index.js';
import { callTool, FIXTURES_DIR } from './support.js';

const fx = loadNetsecFixtures(FIXTURES_DIR);

type Outcome = ReturnType<typeof firewallRulesSearch>;

function okData(outcome: Outcome): Record<string, unknown> {
  expect(outcome.kind).toBe('ok');
  return (outcome as { kind: 'ok'; data: Record<string, unknown> }).data;
}

describe('firewallRulesSearch', () => {
  it('filters by service and reports coverage', () => {
    const data = okData(firewallRulesSearch(fx, { service: 'payments-api' }));
    const rules = data.rules as FirewallRule[];
    expect(rules.map((r) => r.rule_id)).toEqual(['FW-1001', 'FW-1002', 'FW-1005', 'FW-1006']);
    expect(data.total_matched).toBe(4);
    expect(data.truncated).toBe(false);
    expect(data.service_covered).toBe(true);
  });

  it('a service absent from the ruleset answers ok with service_covered false', () => {
    const data = okData(firewallRulesSearch(fx, { service: 'analytics' }));
    expect(data.rules).toEqual([]);
    expect(data.service_covered).toBe(false);
  });

  it('filters by port and direction without a coverage flag', () => {
    const data = okData(firewallRulesSearch(fx, { port: 443, direction: 'ingress' }));
    const rules = data.rules as FirewallRule[];
    expect(rules.map((r) => r.rule_id)).toEqual(['FW-1001', 'FW-1007']);
    expect(data.service_covered).toBeUndefined();
  });

  it('filters by source cidr', () => {
    const data = okData(firewallRulesSearch(fx, { cidr: '203.0.113.0/24' }));
    expect((data.rules as FirewallRule[]).map((r) => r.rule_id)).toEqual(['FW-1009']);
  });

  it('truncates at the limit and says so', () => {
    const data = okData(firewallRulesSearch(fx, { service: 'payments-api', limit: 2 }));
    expect((data.rules as FirewallRule[]).length).toBe(2);
    expect(data.total_matched).toBe(4);
    expect(data.truncated).toBe(true);
  });

  it('rejects a filterless dump, a bad direction, and a bad limit with typed outcomes', () => {
    expect(firewallRulesSearch(fx, {})).toEqual({
      kind: 'invalid_input',
      message: 'provide at least one filter — unbounded ruleset dumps are not a tool',
    });
    expect(firewallRulesSearch(fx, { direction: 'sideways' }).kind).toBe('invalid_input');
    expect(firewallRulesSearch(fx, { service: 'payments-api', limit: 0 }).kind).toBe(
      'invalid_input',
    );
    expect(firewallRulesSearch(fx, { service: 'payments-api', limit: 51 }).kind).toBe(
      'invalid_input',
    );
  });
});

describe('securityGroupGet', () => {
  it('gets one group by id', () => {
    const data = okData(securityGroupGet(fx, { security_group_id: 'sg-payments-01' }));
    const groups = data.groups as SecurityGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.service).toBe('payments-api');
  });

  it('an injection-shaped id rides as a literal and is a typed not_found', () => {
    const outcome = securityGroupGet(fx, {
      security_group_id: 'sg-payments-01"; DROP TABLE groups; --',
    });
    expect(outcome.kind).toBe('not_found');
    expect((outcome as { message: string }).message).toContain('DROP TABLE');
  });

  it('filters by service, and an uncovered service answers ok with an empty list', () => {
    const covered = okData(securityGroupGet(fx, { service: 'ledger-core' }));
    expect((covered.groups as SecurityGroup[]).map((g) => g.security_group_id)).toEqual([
      'sg-ledger-01',
    ]);
    const uncovered = okData(securityGroupGet(fx, { service: 'analytics' }));
    expect(uncovered.groups).toEqual([]);
  });

  it('no filter returns the whole (bounded) snapshot', () => {
    const data = okData(securityGroupGet(fx, {}));
    expect((data.groups as SecurityGroup[]).length).toBe(4);
  });
});

describe('ipamLookup', () => {
  it('filters by service', () => {
    const data = okData(ipamLookup(fx, { service: 'payments-api' }));
    const allocations = data.allocations as IpamAllocation[];
    expect(allocations.map((a) => a.zone).sort()).toEqual(['private', 'public']);
  });

  it('filters by cidr and by ip membership', () => {
    const byCidr = okData(ipamLookup(fx, { cidr: '10.20.2.0/24' }));
    expect((byCidr.allocations as IpamAllocation[])[0]!.service).toBe('ledger-core');
    const byIp = okData(ipamLookup(fx, { ip: '198.51.100.20' }));
    expect((byIp.allocations as IpamAllocation[])[0]!.service).toBe('checkout-web');
  });

  it('an unknown service answers ok with an empty list', () => {
    expect(okData(ipamLookup(fx, { service: 'analytics' })).allocations).toEqual([]);
  });
});

describe('vulnScanReport', () => {
  it('filters by service and severity', () => {
    const data = okData(vulnScanReport(fx, { service: 'payments-api', severity: 'critical' }));
    const findings = data.findings as VulnFinding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.cve).toBe('CVE-2026-31337');
  });

  it('filters by image', () => {
    const data = okData(vulnScanReport(fx, { image: 'acme/ledger-core:3.1.0' }));
    expect((data.findings as VulnFinding[]).map((f) => f.cve)).toEqual(['CVE-2026-11204']);
  });

  it('rejects an unknown severity with a typed invalid_input', () => {
    expect(vulnScanReport(fx, { severity: 'apocalyptic' }).kind).toBe('invalid_input');
  });
});

describe('netsec MCP round trips', () => {
  it('serves each tool with its own dataset provenance', async () => {
    const server = () => createNetsecServer(fx);
    const cases: [string, Record<string, unknown>, { doc_id: string }][] = [
      ['firewall_rules_search', { service: 'payments-api' }, fx.firewallRules.document],
      ['security_group_get', { service: 'payments-api' }, fx.securityGroups.document],
      ['ipam_lookup', { service: 'payments-api' }, fx.ipam.document],
      ['vuln_scan_report', { service: 'payments-api' }, fx.vulnScans.document],
    ];
    for (const [tool, args, document] of cases) {
      const result = await callTool(server(), tool, args);
      expect(result.isError, `${tool} errored`).toBe(false);
      const envelope = result.structuredContent as {
        ok: boolean;
        provenance: { doc_id: string }[];
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.provenance).toEqual([document]);
    }
  });

  it('an injection-shaped security group id round-trips to a typed not_found', async () => {
    const result = await callTool(createNetsecServer(fx), 'security_group_get', {
      security_group_id: 'sg-1"; DROP TABLE groups; --',
    });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { error: { code: string } };
    expect(envelope.error.code).toBe('not_found');
  });

  it('honors the scripted rate_limited failure directive', async () => {
    const limited = createNetsecServer(fx, { failure: { kind: 'rate_limited', retryAfterS: 2 } });
    const result = await callTool(limited, 'firewall_rules_search', { service: 'payments-api' });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { retry_after_s: number } }).error.retry_after_s,
    ).toBe(2);
  });
});
