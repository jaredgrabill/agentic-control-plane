import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalBaseline, EvalReport } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyGate,
  BUILTIN_TOLERANCES,
  FALLBACK_TOLERANCE,
  loadGateConfig,
  resolveTolerance,
  type GateConfig,
} from '../src/gate.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures', 'regressed');
const DIGEST = `sha256:${'a'.repeat(64)}`;

function baseline(overrides: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    schema: 'acp-eval-baseline/v1',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    suite: { digest: DIGEST, case_count: 7 },
    harness: 'acp-agent-sdk-py@0.1.0',
    recorded_at: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schema: 'acp-eval-report/v1',
    sdk: 'acp-agent-sdk-py@0.1.0',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    suite: { digest: DIGEST, case_count: 7 },
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    cases: [],
    ...overrides,
  };
}

describe('resolveTolerance', () => {
  it('resolves config.tolerances → default_tolerance → builtin → fallback, in that order', () => {
    const config: GateConfig = { tolerances: { pass_rate: 0.1 }, default_tolerance: 0.03 };
    expect(resolveTolerance('pass_rate', config)).toBe(0.1);
    expect(resolveTolerance('citation_precision', config)).toBe(0.03);
    expect(resolveTolerance('pass_rate')).toBe(BUILTIN_TOLERANCES.pass_rate);
    expect(resolveTolerance('abstention_accuracy')).toBe(0);
    expect(resolveTolerance('conflict_recall')).toBe(FALLBACK_TOLERANCE);
    expect(resolveTolerance('conflict_recall', { default_tolerance: 0 })).toBe(0);
  });
});

describe('loadGateConfig', () => {
  const FILE = 'python/agents/knowledge/evals/gate.json';

  it('accepts the documented shape (the committed knowledge-agent config)', () => {
    const text = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'python',
        'agents',
        'knowledge',
        'evals',
        'gate.json',
      ),
      'utf-8',
    );
    const config = loadGateConfig(text, FILE);
    expect(config.tolerances).toEqual({
      pass_rate: 0,
      citation_precision: 0,
      abstention_accuracy: 0,
    });
    expect(config.default_tolerance).toBe(0);
  });

  it('names the file when the JSON does not parse', () => {
    expect(() => loadGateConfig('{ "default_tolerance": 0,', FILE)).toThrow(
      /invalid gate config python\/agents\/knowledge\/evals\/gate\.json: not valid JSON/,
    );
  });

  it('rejects a non-object document', () => {
    expect(() => loadGateConfig('[]', FILE)).toThrow(/expected a JSON object/);
    expect(() => loadGateConfig('null', FILE)).toThrow(/expected a JSON object/);
  });

  it('rejects a string tolerance', () => {
    expect(() =>
      loadGateConfig(JSON.stringify({ tolerances: { pass_rate: '0.05' } }), FILE),
    ).toThrow(
      /invalid gate config .*gate\.json: tolerances\.pass_rate must be a finite number in \[0, 1\], got "0\.05"/,
    );
    expect(() => loadGateConfig(JSON.stringify({ default_tolerance: '0' }), FILE)).toThrow(
      /default_tolerance must be a finite number in \[0, 1\], got "0"/,
    );
  });

  it('rejects a negative tolerance and one above 1', () => {
    expect(() =>
      loadGateConfig(JSON.stringify({ tolerances: { pass_rate: -0.05 } }), FILE),
    ).toThrow(/tolerances\.pass_rate must be a finite number in \[0, 1\], got -0\.05/);
    expect(() => loadGateConfig(JSON.stringify({ default_tolerance: 1.5 }), FILE)).toThrow(
      /default_tolerance must be a finite number in \[0, 1\], got 1\.5/,
    );
  });

  it('rejects unknown keys — a typo must not silently fall back to builtin tolerances', () => {
    expect(() => loadGateConfig(JSON.stringify({ tolerence: { pass_rate: 0 } }), FILE)).toThrow(
      /invalid gate config .*gate\.json: unknown key "tolerence"/,
    );
  });

  it('rejects a wrong schema const and a non-record tolerances', () => {
    expect(() => loadGateConfig(JSON.stringify({ schema: 'acp-eval-gate/v2' }), FILE)).toThrow(
      /schema must be "acp-eval-gate\/v1"/,
    );
    expect(() => loadGateConfig(JSON.stringify({ tolerances: [0.05] }), FILE)).toThrow(
      /tolerances must be an object mapping metric names to numbers/,
    );
  });
});

describe('applyGate', () => {
  it('passes an identical run', () => {
    expect(applyGate(baseline(), report())).toEqual({ ok: true, violations: [] });
  });

  it('rejects the committed regressed fixtures with exact metric violations', () => {
    const regressedBaseline = JSON.parse(
      readFileSync(join(fixturesDir, 'baseline.json'), 'utf-8'),
    ) as EvalBaseline;
    const regressedReport = JSON.parse(
      readFileSync(join(fixturesDir, 'report.json'), 'utf-8'),
    ) as EvalReport;
    const result = applyGate(regressedBaseline, regressedReport);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'pass_rate 0.7143 < baseline 1.0000 − tolerance 0.05',
      'citation_precision 0.5000 < baseline 1.0000 − tolerance 0.02',
    ]);
  });

  it('short-circuits on agent mismatch before comparing anything else', () => {
    const result = applyGate(baseline({ agent_id: 'other-agent' }), report());
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'baseline is for agent other-agent but the report is for knowledge-agent',
    ]);
  });

  it('short-circuits on a suite digest change with re-baselining instructions', () => {
    const changed = report({ suite: { digest: `sha256:${'b'.repeat(64)}`, case_count: 8 } });
    const result = applyGate(baseline(), changed);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('golden suite changed');
    expect(result.violations[0]).toContain('refresh evals/baseline.json in this PR');
    // No metric comparison happened: pass_rate is identical anyway.
    expect(result.violations[0]).toContain(DIGEST);
  });

  it('holds exactly at baseline − tolerance and fails just below it', () => {
    const base = baseline({
      metrics: { pass_rate: 0.9, citation_precision: 1, abstention_accuracy: 1 },
    });
    const atBoundary = report({
      metrics: { pass_rate: 0.85, citation_precision: 1, abstention_accuracy: 1 },
    });
    expect(applyGate(base, atBoundary).ok).toBe(true);

    const justBelow = report({
      metrics: { pass_rate: 0.8499, citation_precision: 1, abstention_accuracy: 1 },
    });
    const result = applyGate(base, justBelow);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['pass_rate 0.8499 < baseline 0.9000 − tolerance 0.05']);
  });

  it('absorbs float noise below the 1e-9 epsilon', () => {
    const base = baseline({
      metrics: { pass_rate: 4 / 9, citation_precision: 1, abstention_accuracy: 1 },
    });
    const noisy = report({
      metrics: {
        pass_rate: 4 / 9 - 1e-12,
        citation_precision: 1,
        abstention_accuracy: 1,
      },
    });
    expect(applyGate(base, noisy, { default_tolerance: 0 }).ok).toBe(true);
  });

  it('flags baseline metrics missing from the report and ignores extra candidate metrics', () => {
    const base = baseline({
      metrics: {
        pass_rate: 1,
        citation_precision: 1,
        abstention_accuracy: 1,
        conflict_recall: 0.9,
      },
    });
    const missing = applyGate(base, report());
    expect(missing.ok).toBe(false);
    expect(missing.violations).toEqual([
      'baseline metric conflict_recall is missing from the candidate report',
    ]);

    const extra = report({
      metrics: {
        pass_rate: 1,
        citation_precision: 1,
        abstention_accuracy: 1,
        novelty_score: 0.1,
      },
    });
    expect(applyGate(baseline(), extra)).toEqual({ ok: true, violations: [] });
  });

  it('honors zero tolerances from a gate config', () => {
    const dip = report({
      metrics: { pass_rate: 0.9999, citation_precision: 1, abstention_accuracy: 1 },
    });
    expect(applyGate(baseline(), dip).ok).toBe(true); // builtin 0.05 tolerance
    const result = applyGate(baseline(), dip, { default_tolerance: 0 });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['pass_rate 0.9999 < baseline 1.0000 − tolerance 0']);
  });
});
