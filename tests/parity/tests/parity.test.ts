import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareReports } from '../src/compare.js';
import { runParity, type ParityReport } from '../src/report.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/parity', import.meta.url));

const EXPECTED_PASS_VECTOR = [true, true, false, true, false, true, false, false, false];

async function tsReport(): Promise<ParityReport> {
  return runParity(FIXTURES);
}

describe('runParity', () => {
  it('pins the TypeScript verdicts over the shared fixtures', async () => {
    const report = await tsReport();
    expect(report.schema).toBe('acp-parity-report/v1');
    expect(report.sdk).toBe('typescript');
    expect(report.agent_id).toBe('parity-agent');
    expect(report.cases).toHaveLength(9);
    expect(report.cases.map((c) => c.passed)).toEqual(EXPECTED_PASS_VECTOR);

    expect(Math.abs(report.metrics.pass_rate - 4 / 9)).toBeLessThan(1e-9);
    expect(Math.abs(report.metrics.citation_precision - 4 / 9)).toBeLessThan(1e-9);
    expect(Math.abs(report.metrics.abstention_accuracy - 8 / 9)).toBeLessThan(1e-9);
  });

  it('cites all three docs in table order on the multi-doc case', async () => {
    const report = await tsReport();
    expect(report.cases[1]?.name).toBe('multi-doc grounding');
    expect(report.cases[1]?.cited_docs).toEqual([
      'policy/change-management',
      'runbook/oncall-escalation',
      'policy/data-retention',
    ]);
  });

  it('pins the cross-checkable failure strings', async () => {
    const report = await tsReport();
    expect(report.cases[2]?.failures).toEqual(["answer does not mention 'unicorns'"]);
    expect(report.cases[4]?.failures).toEqual(['abstained on an answerable question']);
    expect(report.cases[6]?.failures[0]).toMatch(
      /^step failed: handler output does not conform to the declared output_schema/,
    );
    expect(report.cases[7]?.failures).toEqual(['confidence 0.75 below floor 0.9']);
    expect(report.cases[8]?.failures).toEqual(['answer does not cite policy/nonexistent']);
  });
});

describe('compareReports', () => {
  it('a report matches its clone', async () => {
    const report = await tsReport();
    expect(compareReports(report, structuredClone(report))).toEqual([]);
  });

  it('tolerates a differing output_schema failure tail', async () => {
    const report = await tsReport();
    const other = structuredClone(report);
    other.sdk = 'python';
    other.cases[6]!.failures = [
      "step failed: handler output does not conform to the declared output_schema after one repair retry: 'text' is a required property",
    ];
    expect(compareReports(report, other)).toEqual([]);
  });

  it('flags every kind of drift', async () => {
    const report = await tsReport();

    const flipped = structuredClone(report);
    flipped.cases[0]!.passed = false;
    expect(compareReports(report, flipped)).toEqual([
      "case 'cites the change policy': passed true != false",
    ]);

    const reordered = structuredClone(report);
    reordered.cases[1]!.cited_docs = [...reordered.cases[1]!.cited_docs].reverse();
    expect(compareReports(report, reordered).join('\n')).toContain('cited_docs');

    const perturbed = structuredClone(report);
    perturbed.metrics.pass_rate += 1e-6;
    expect(compareReports(report, perturbed).join('\n')).toContain('metrics.pass_rate');

    const withinTolerance = structuredClone(report);
    withinTolerance.metrics.pass_rate += 1e-12;
    expect(compareReports(report, withinTolerance)).toEqual([]);

    const reworded = structuredClone(report);
    reworded.cases[2]!.failures = ['answer does not mention "unicorns"'];
    expect(compareReports(report, reworded).join('\n')).toContain('failure 0');

    const dropped = structuredClone(report);
    dropped.cases[2]!.failures = [];
    expect(compareReports(report, dropped).join('\n')).toContain('failure count 1 != 0');

    const misnamed = structuredClone(report);
    misnamed.cases[3]!.name = 'renamed';
    expect(compareReports(report, misnamed).join('\n')).toContain("name 'expected abstention'");

    const truncated = structuredClone(report);
    truncated.cases.pop();
    expect(compareReports(report, truncated)).toEqual(['case count: 9 != 8']);

    const wrongAgent = structuredClone(report);
    wrongAgent.agent_id = 'other-agent';
    expect(compareReports(report, wrongAgent).join('\n')).toContain('agent_id');

    const wrongAbstain = structuredClone(report);
    wrongAbstain.cases[3]!.abstained = false;
    expect(compareReports(report, wrongAbstain).join('\n')).toContain('abstained true != false');

    const wrongSchema = structuredClone(report);
    wrongSchema.schema = 'acp-parity-report/v2';
    expect(compareReports(report, wrongSchema)).toEqual([
      "report b: unexpected schema 'acp-parity-report/v2'",
    ]);
    expect(compareReports(wrongSchema, report)).toEqual([
      "report a: unexpected schema 'acp-parity-report/v2'",
    ]);
  });
});
