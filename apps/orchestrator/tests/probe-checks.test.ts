import type { Answer } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { checkProbe } from '../src/probe-checks.js';

const answer = (over: Partial<Answer>): Answer => ({
  text: 'The standard policy grants 20 vacation days per year.',
  citations: [
    { doc_id: 'policy-4', version: '1', lineage_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
  ],
  confidence: 0.9,
  ...over,
});

describe('checkProbe', () => {
  it('passes when the answer contains the expected substrings (case-insensitive)', () => {
    const r = checkProbe(answer({}), { must_contain: ['20 VACATION days'] });
    expect(r.passed).toBe(true);
    expect(r.checks.must_contain).toBe(true);
  });

  it('fails when a required substring is missing', () => {
    const r = checkProbe(answer({}), { must_contain: ['30 days'] });
    expect(r.passed).toBe(false);
    expect(r.checks.must_contain).toBe(false);
  });

  it('checks required citations by doc_id', () => {
    expect(checkProbe(answer({}), { must_cite_docs: ['policy-4'] }).checks.must_cite_docs).toBe(
      true,
    );
    expect(checkProbe(answer({}), { must_cite_docs: ['policy-9'] }).checks.must_cite_docs).toBe(
      false,
    );
  });

  it('honors an expected abstention', () => {
    expect(checkProbe(answer({ abstained: true }), { abstain: true }).passed).toBe(true);
    expect(checkProbe(answer({ abstained: false }), { abstain: true }).passed).toBe(false);
    // expect.abstain false → must NOT abstain.
    expect(checkProbe(answer({ abstained: true }), { abstain: false }).passed).toBe(false);
  });

  it('ignores abstention when unspecified', () => {
    expect(checkProbe(answer({ abstained: true }), { must_contain: ['20 vacation'] }).passed).toBe(
      true,
    );
  });

  it('a null answer fails every content expectation', () => {
    const r = checkProbe(null, { must_contain: ['anything'], must_cite_docs: ['policy-4'] });
    expect(r.passed).toBe(false);
    expect(r.checks.must_contain).toBe(false);
    expect(r.checks.must_cite_docs).toBe(false);
  });
});
