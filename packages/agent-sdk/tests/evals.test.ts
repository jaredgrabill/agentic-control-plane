import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  CapabilityError,
  ErrorClass,
  EvalHarness,
  goldenCaseFromDict,
  loadGolden,
  type GoldenCase,
} from '../src/index.js';
import { MANIFEST } from './fixtures.js';

function makeAgent(): Agent {
  const agent = new Agent({ manifest: MANIFEST });
  agent.capability('test.echo', (_ctx, input) => {
    const question = typeof input.text === 'string' ? input.text : '';
    if (question.includes('unanswerable')) {
      return Promise.resolve({
        text: "I don't have sufficient grounding to answer this.",
        citations: [],
        confidence: 0.1,
        abstained: true,
      });
    }
    return Promise.resolve({
      text: `The change freeze applies. (asked: ${question}) [1]`,
      citations: [
        { doc_id: 'policy/change-management', version: '3.2.0', lineage_id: 'x' },
        { doc_id: 'runbook/oncall-escalation', version: '3.0.0', lineage_id: 'y' },
      ],
      confidence: 0.9,
    });
  });
  return agent;
}

function goldenCase(overrides: Record<string, unknown> = {}): GoldenCase {
  return goldenCaseFromDict({
    name: 'case',
    capability: 'test.echo',
    input: { text: 'what about change freezes?' },
    expect: {},
    ...overrides,
  });
}

describe('EvalHarness', () => {
  it('scores passing and failing content assertions', async () => {
    const report = await new EvalHarness(makeAgent()).run([
      goldenCase({ name: 'mentions freeze', expect: { must_contain: ['change freeze'] } }),
      goldenCase({ name: 'mentions unicorns', expect: { must_contain: ['unicorns'] } }),
    ]);
    expect(report.results.map((r) => r.passed)).toEqual([true, false]);
    expect(report.summary()).toContain('unicorns');
    expect(report.results[1]?.failures).toEqual(["answer does not mention 'unicorns'"]);
    expect(report.passRate).toBe(0.5);
    expect(report.passed).toBe(false);
  });

  it('citation precision counts expected docs only', async () => {
    const report = await new EvalHarness(makeAgent()).run([
      goldenCase({ expect: { must_cite_docs: ['policy/change-management'] } }),
    ]);
    // Two docs cited, one expected → precision 0.5, but the expected doc
    // IS cited so the case itself passes.
    expect(report.results[0]?.passed).toBe(true);
    expect(report.citationPrecision).toBe(0.5);
  });

  it('citation precision defaults to 1.0 with no must_cite_docs cases', async () => {
    const report = await new EvalHarness(makeAgent()).run([goldenCase()]);
    expect(report.citationPrecision).toBe(1);
  });

  it('scores abstention in both directions', async () => {
    const report = await new EvalHarness(makeAgent()).run([
      goldenCase({
        name: 'should abstain',
        input: { text: 'unanswerable' },
        expect: { abstain: true },
      }),
      goldenCase({ name: 'wrongly abstains', input: { text: 'unanswerable' }, expect: {} }),
      goldenCase({ name: 'answers fine', expect: { min_confidence: 0.8 } }),
    ]);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[1]?.passed).toBe(false);
    expect(report.results[1]?.failures).toEqual(['abstained on an answerable question']);
    expect(report.results[2]?.passed).toBe(true);
    expect(report.abstentionAccuracy).toBeCloseTo(2 / 3, 12);
  });

  it('an unmet confidence floor fails with both numbers', async () => {
    const report = await new EvalHarness(makeAgent()).run([
      goldenCase({ name: 'floor', expect: { min_confidence: 0.95 } }),
    ]);
    expect(report.results[0]?.failures).toEqual(['confidence 0.9 below floor 0.95']);
  });

  it('expect.error_class accepts a matching typed failure', async () => {
    const agent = new Agent({ manifest: MANIFEST });
    agent.capability('test.echo', () =>
      Promise.reject(new CapabilityError(ErrorClass.NeedsInput, 'which audience do you mean?')),
    );
    const report = await new EvalHarness(agent).run([
      goldenCase({ name: 'needs input', expect: { error_class: 'needs_input' } }),
    ]);
    expect(report.results[0]?.passed, report.summary()).toBe(true);
  });

  it('expect.error_class mismatches name the actual outcome', async () => {
    const completed = await new EvalHarness(makeAgent()).run([
      goldenCase({ name: 'wanted a failure', expect: { error_class: 'needs_input' } }),
    ]);
    expect(completed.results[0]?.failures).toEqual([
      'expected a needs_input failure, got a completed step',
    ]);

    const agent = new Agent({ manifest: MANIFEST });
    agent.capability('test.echo', () =>
      Promise.reject(new CapabilityError(ErrorClass.Permanent, 'wrong class')),
    );
    const wrongClass = await new EvalHarness(agent).run([
      goldenCase({ name: 'wrong class', expect: { error_class: 'needs_input' } }),
    ]);
    expect(wrongClass.results[0]?.failures).toEqual([
      'expected a needs_input failure, got permanent',
    ]);
  });

  it('forwards the delegated token into every StepRequest', async () => {
    const agent = new Agent({ manifest: MANIFEST });
    const tokens: (string | undefined)[] = [];
    agent.capability('test.echo', (ctx) => {
      tokens.push(ctx.delegatedToken);
      return Promise.resolve({ text: 'ok', citations: [], confidence: 0.9 });
    });
    await new EvalHarness(agent, { delegatedToken: 'eval-token' }).run([goldenCase()]);
    await new EvalHarness(agent).run([goldenCase()]);
    expect(tokens).toEqual(['eval-token', undefined]);
  });
});

describe('loadGolden', () => {
  it('reads files sorted and rejects an empty suite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-golden-'));
    try {
      writeFileSync(
        join(dir, 'b.json'),
        JSON.stringify({
          cases: [{ name: 'second', capability: 'test.echo', input: {}, expect: {} }],
        }),
        'utf-8',
      );
      writeFileSync(
        join(dir, 'a.json'),
        JSON.stringify({
          cases: [
            {
              name: 'first',
              capability: 'test.echo',
              input: {},
              expect: { min_confidence: 0.5, error_class: 'needs_input' },
            },
          ],
        }),
        'utf-8',
      );
      const cases = loadGolden(dir);
      expect(cases.map((c) => c.name)).toEqual(['first', 'second']);
      expect(cases[0]?.minConfidence).toBe(0.5);
      expect(cases[0]?.expectErrorClass).toBe('needs_input');
      expect(cases[1]?.minConfidence).toBeUndefined();
      expect(cases[1]?.expectErrorClass).toBeUndefined();
      expect(() => loadGolden(join(dir, 'empty'))).toThrow('no golden cases');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
