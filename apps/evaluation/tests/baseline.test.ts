import { evalBaseline, type EvalReport } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { baselineFromReport } from '../src/baseline.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schema: 'acp-eval-report/v1',
    sdk: 'acp-agent-sdk-ts@0.1.0',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    suite: { digest: DIGEST, case_count: 7, path: 'python/agents/knowledge/evals/golden' },
    metrics: { pass_rate: 1, citation_precision: 0.9583, abstention_accuracy: 1 },
    cases: [],
    generated_at: '2026-07-11T08:30:00.000Z',
    ...overrides,
  };
}

describe('baselineFromReport', () => {
  it('maps the report fields, pins the schema const, and round-trips the parser', () => {
    const baseline = baselineFromReport(report());
    expect(baseline).toEqual({
      schema: 'acp-eval-baseline/v1',
      agent_id: 'knowledge-agent',
      agent_version: '0.1.0',
      metrics: { pass_rate: 1, citation_precision: 0.9583, abstention_accuracy: 1 },
      suite: { digest: DIGEST, case_count: 7, path: 'python/agents/knowledge/evals/golden' },
      harness: 'acp-agent-sdk-ts@0.1.0',
      recorded_at: '2026-07-11T08:30:00.000Z',
    });
    expect(evalBaseline.parse(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
  });

  it('is a pure function of a timestamped report: regeneration is byte-identical', () => {
    const a = JSON.stringify(baselineFromReport(report()), null, 2);
    const b = JSON.stringify(baselineFromReport(report()), null, 2);
    expect(a).toBe(b);
  });

  it('falls back to the injected clock when the report has no generated_at', () => {
    const { generated_at: _generatedAt, ...untimestamped } = report();
    const baseline = baselineFromReport(untimestamped, () => new Date('2026-07-12T00:00:00Z'));
    expect(baseline.recorded_at).toBe('2026-07-12T00:00:00.000Z');
    expect(evalBaseline.validate(JSON.parse(JSON.stringify(baseline)))).toBe(true);
  });
});
