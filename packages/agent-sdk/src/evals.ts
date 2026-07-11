/**
 * EvalHarness: golden-set runner usable locally and in CI with identical
 * semantics (paved-road.md). Deterministic checks first (testing.md):
 * citation precision, abstention correctness, content assertions — judge
 * rubrics arrive with the Evaluation Service in Phase 2.
 *
 * Failure strings are byte-identical to the Python SDK's: the cross-SDK
 * parity gate (tests/parity) compares them verbatim.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepRequest } from '@acp/protocol';
import type { Agent } from './agent.js';
import type { ErrorClass } from './errors.js';

export interface GoldenCase {
  name: string;
  capability: string;
  input: Record<string, unknown>;
  mustContain: string[];
  mustCiteDocs: string[];
  expectAbstain: boolean;
  minConfidence: number | undefined;
  /** When set, the case expects a typed failure of exactly this class. */
  expectErrorClass: ErrorClass | undefined;
}

/**
 * Case file shape:
 * `{name, capability, input, expect: {must_contain, must_cite_docs, abstain, min_confidence, error_class}}`.
 */
export function goldenCaseFromDict(raw: Record<string, unknown>): GoldenCase {
  const expect = (raw.expect ?? {}) as Record<string, unknown>;
  return {
    name: String(raw.name),
    capability: String(raw.capability),
    input: (raw.input ?? {}) as Record<string, unknown>,
    mustContain: (expect.must_contain as string[] | undefined) ?? [],
    mustCiteDocs: (expect.must_cite_docs as string[] | undefined) ?? [],
    expectAbstain: Boolean(expect.abstain ?? false),
    minConfidence: expect.min_confidence as number | undefined,
    expectErrorClass: expect.error_class as ErrorClass | undefined,
  };
}

/** Reads every *.json under `directory` (sorted); an empty suite is a loud failure. */
export function loadGolden(directory: string): GoldenCase[] {
  let files: string[] = [];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    // Missing directory falls through to the empty-suite failure below.
  }
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(directory, file), 'utf-8')) as {
      cases: Record<string, unknown>[];
    };
    cases.push(...doc.cases.map(goldenCaseFromDict));
  }
  if (cases.length === 0) {
    throw new Error(`no golden cases found under ${directory} — no eval suite, no registration`);
  }
  return cases;
}

export interface CaseResult {
  name: string;
  passed: boolean;
  failures: string[];
  citedDocs: string[];
  abstained: boolean;
}

export class EvalReport {
  constructor(
    readonly results: CaseResult[],
    readonly citationPrecision: number,
    readonly abstentionAccuracy: number,
    readonly passRate: number,
  ) {}

  get passed(): boolean {
    return this.results.every((r) => r.passed);
  }

  summary(): string {
    const lines = [
      `golden cases: ${this.results.length}  pass_rate=${this.passRate.toFixed(2)}  ` +
        `citation_precision=${this.citationPrecision.toFixed(2)}  ` +
        `abstention_accuracy=${this.abstentionAccuracy.toFixed(2)}`,
    ];
    for (const r of this.results) {
      if (!r.passed) lines.push(`FAIL ${r.name}: ${r.failures.join('; ')}`);
    }
    return lines.join('\n');
  }
}

export class EvalHarness {
  private readonly agent: Agent;
  private readonly delegatedToken: string | undefined;

  constructor(agent: Agent, options: { delegatedToken?: string } = {}) {
    this.agent = agent;
    this.delegatedToken = options.delegatedToken;
  }

  /**
   * Metrics, verbatim from the Python harness: citation_precision is the mean
   * over cases with must_cite_docs of |cited ∩ expected| / |cited| (1.0 when
   * no such cases); abstention_accuracy the fraction of all cases whose
   * abstention matched; pass_rate the fraction passed. Thresholds live in
   * consumer tests, not here.
   */
  async run(cases: GoldenCase[]): Promise<EvalReport> {
    const results: CaseResult[] = [];
    const precisions: number[] = [];
    const abstentionHits: boolean[] = [];
    for (const goldenCase of cases) {
      const result = await this.runCase(goldenCase);
      results.push(result);
      if (goldenCase.mustCiteDocs.length > 0) {
        const cited = new Set(result.citedDocs);
        const expected = new Set(goldenCase.mustCiteDocs);
        const overlap = [...cited].filter((doc) => expected.has(doc)).length;
        precisions.push(cited.size > 0 ? overlap / cited.size : 0);
      }
      abstentionHits.push(result.abstained === goldenCase.expectAbstain);
    }
    return new EvalReport(
      results,
      precisions.length > 0 ? precisions.reduce((a, b) => a + b, 0) / precisions.length : 1,
      abstentionHits.length > 0 ? abstentionHits.filter(Boolean).length / abstentionHits.length : 1,
      results.length > 0 ? results.filter((r) => r.passed).length / results.length : 0,
    );
  }

  private async runCase(goldenCase: GoldenCase): Promise<CaseResult> {
    const request: StepRequest = {
      kind: 'step_request',
      step_id: randomUUID(),
      task_id: randomUUID(),
      tenant: 'acme',
      agent_id: this.agent.agentId,
      capability: goldenCase.capability,
      input: goldenCase.input,
    };
    if (this.delegatedToken !== undefined) request.delegated_token = this.delegatedToken;
    const step = await this.agent.execute(request);

    const failures: string[] = [];
    const output =
      step.status === 'completed' ? ((step.output ?? {}) as Record<string, unknown>) : {};
    const text = typeof output.text === 'string' ? output.text : '';
    const citations = (output.citations as Record<string, unknown>[] | undefined) ?? [];
    const citedDocs = citations.map((citation) => String(citation.doc_id));
    const abstained = Boolean(output.abstained ?? false);

    if (goldenCase.expectErrorClass !== undefined) {
      // A typed failure IS the expected behavior; any other outcome fails.
      const actual = step.status !== 'completed' ? step.error?.class : undefined;
      if (actual !== goldenCase.expectErrorClass) {
        failures.push(
          `expected a ${goldenCase.expectErrorClass} failure, got ${actual ?? 'a completed step'}`,
        );
      }
    } else if (step.status !== 'completed') {
      failures.push(`step failed: ${step.error?.message ?? 'unknown'}`);
    }
    for (const needle of goldenCase.mustContain) {
      if (!text.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`answer does not mention '${needle}'`);
      }
    }
    for (const doc of goldenCase.mustCiteDocs) {
      if (!citedDocs.includes(doc)) {
        failures.push(`answer does not cite ${doc}`);
      }
    }
    if (goldenCase.expectAbstain && !abstained) {
      failures.push('expected abstention, got a confident answer');
    }
    if (!goldenCase.expectAbstain && abstained) {
      failures.push('abstained on an answerable question');
    }
    if (
      goldenCase.minConfidence !== undefined &&
      Number(output.confidence ?? 0) < goldenCase.minConfidence
    ) {
      failures.push(
        `confidence ${String(output.confidence)} below floor ${String(goldenCase.minConfidence)}`,
      );
    }

    return {
      name: goldenCase.name,
      passed: failures.length === 0,
      failures,
      citedDocs,
      abstained,
    };
  }
}
