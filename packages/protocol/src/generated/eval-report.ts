/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

export type UnitInterval = number;

/**
 * One run of an agent's golden eval suite, emitted by an SDK harness (evaluation.md). The report is the evidence; the eval_baseline derived from an accepted run is what the registry records on the agent card and what CI gates against — gates are baseline-relative, never absolute.
 */
export interface EvalReport {
  schema: 'acp-eval-report/v1';
  /**
   * Harness that produced the run, e.g. acp-agent-sdk-py@0.1.0 or acp-agent-sdk-ts@0.1.0.
   */
  sdk: string;
  /**
   * Stable agent identifier (kebab-case); same pattern as the manifest id.
   */
  agent_id: string;
  /**
   * Semver of the capability contract the suite ran against.
   */
  agent_version: string;
  suite: EvalSuite;
  metrics: EvalMetrics;
  /**
   * Per-case verdicts in run (golden-file) order.
   */
  cases: EvalCaseResult[];
  generated_at?: string;
}
/**
 * Identity of the golden suite the run scored: a content digest over the case files, so a baseline can refuse comparison when the suite itself changed.
 */
export interface EvalSuite {
  /**
   * sha256 over the sorted *.json case files (basename NUL content NUL per file, CRLF normalized to LF).
   */
  digest: string;
  case_count: number;
  /**
   * Repo-relative suite directory, informational.
   */
  path?: string;
}
/**
 * Gated metrics, all higher-is-better on [0, 1]. Extra domain-specific metrics are allowed and gate like the core three.
 */
export interface EvalMetrics {
  pass_rate: UnitInterval;
  citation_precision: UnitInterval;
  abstention_accuracy: UnitInterval;
  [k: string]: UnitInterval;
}
export interface EvalCaseResult {
  name: string;
  passed: boolean;
  abstained: boolean;
  cited_docs: string[];
  failures: string[];
}
