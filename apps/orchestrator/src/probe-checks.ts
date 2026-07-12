import type { Answer } from '@acp/protocol';
import type { ProbeExpect } from '@acp/online-eval';

/**
 * Golden known-answer checks for a synthetic probe — deterministic and
 * judge-INDEPENDENT (a probe must signal even when the judge is unhealthy).
 * Pure and isolate-safe.
 */
export interface ProbeCheckResult {
  passed: boolean;
  checks: { must_contain: boolean; must_cite_docs: boolean; abstain: boolean };
}

export function checkProbe(answer: Answer | null, expect: ProbeExpect): ProbeCheckResult {
  const text = (answer?.text ?? '').toLowerCase();
  const docs = new Set((answer?.citations ?? []).map((c) => c.doc_id));

  const mustContain = (expect.must_contain ?? []).every((s) => text.includes(s.toLowerCase()));
  const mustCite = (expect.must_cite_docs ?? []).every((d) => docs.has(d));
  // abstain undefined → don't care; else the observed abstention must match.
  const abstain =
    expect.abstain === undefined ? true : (answer?.abstained ?? false) === expect.abstain;

  return {
    passed: mustContain && mustCite && abstain,
    checks: { must_contain: mustContain, must_cite_docs: mustCite, abstain },
  };
}
