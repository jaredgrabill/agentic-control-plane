/**
 * EvalHarness: golden-set runner usable locally and in CI with identical
 * semantics (paved-road.md). Deterministic checks first (testing.md):
 * citation precision, abstention correctness, content assertions — judge
 * rubrics arrive with the Evaluation Service in Phase 2.
 *
 * Failure strings are byte-identical to the Python SDK's: the cross-SDK
 * parity gate (tests/parity) compares them verbatim.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport as ProtocolEvalReport, StepRequest } from '@acp/protocol';
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

/**
 * Content digest identifying a golden suite (acp-eval-report/v1 suite.digest).
 *
 * Normative algorithm, byte-identical across the TypeScript and Python
 * SDKs: take the basenames of the `*.json` files directly under
 * `directory`, sorted ascending by code point; for each file feed sha256
 * with utf8(basename), 0x00, utf8(text with CRLF normalized to LF), 0x00;
 * return `"sha256:" + hex`. CRLF normalization keeps the digest stable
 * across checkout line-ending policies (Windows).
 */
export function suiteDigest(directory: string): string {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(Buffer.from(name, 'utf-8'));
    hash.update(Buffer.of(0));
    hash.update(
      Buffer.from(readFileSync(join(directory, name), 'utf-8').replaceAll('\r\n', '\n'), 'utf-8'),
    );
    hash.update(Buffer.of(0));
  }
  return `sha256:${hash.digest('hex')}`;
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

/**
 * Renders a string the way Python's `{s!r}` does: single-quoted, but
 * double-quoted when the string contains an apostrophe and no double quote.
 * Backslashes and the chosen quote are escaped. (Control-character escaping
 * is out of scope — golden needles are printable text.) Keeps the
 * `answer does not mention …` failure string byte-identical to the Python
 * SDK's for the parity comparator.
 */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
  return `${quote}${escaped}${quote}`;
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
        failures.push(`answer does not mention ${pyRepr(needle)}`);
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
      // Parity constraint (fixtures/parity/HANDLERS.md "String-formatting
      // constraints"): JSON.parse erases the int/float distinction, so a
      // whole-number confidence renders "1" here but "1.0" in Python — golden
      // min_confidence values and handler confidences must not be whole
      // numbers. A missing confidence renders "undefined" here vs "None" in
      // Python, so missing-confidence cases are not parity-safe either.
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

/**
 * Renders a harness run as an acp-eval-report/v1 wire document
 * (snake_case keys from the generated protocol types).
 *
 * Cases stay in run order; `suite.digest` is {@link suiteDigest} over
 * `options.suiteDir`, so gates can refuse comparison when the suite changed.
 */
export function reportPayload(
  report: EvalReport,
  options: { agentId: string; agentVersion: string; suiteDir: string; sdk?: string },
): ProtocolEvalReport {
  return {
    schema: 'acp-eval-report/v1',
    sdk: options.sdk ?? 'acp-agent-sdk-ts@0.1.0',
    agent_id: options.agentId,
    agent_version: options.agentVersion,
    suite: {
      digest: suiteDigest(options.suiteDir),
      case_count: report.results.length,
    },
    metrics: {
      pass_rate: report.passRate,
      citation_precision: report.citationPrecision,
      abstention_accuracy: report.abstentionAccuracy,
    },
    cases: report.results.map((result) => ({
      name: result.name,
      passed: result.passed,
      abstained: result.abstained,
      cited_docs: result.citedDocs,
      failures: result.failures,
    })),
    generated_at: new Date().toISOString(),
  };
}
