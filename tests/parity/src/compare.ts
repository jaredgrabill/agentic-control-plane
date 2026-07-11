/**
 * Diffs two parity reports. Exact everywhere, with two deliberate slacks:
 * metrics tolerate 1e-9 float noise, and output-schema failure strings are
 * compared by their shared prefix (Ajv and jsonschema phrase the validator
 * tail differently). `sdk` is ignored — it names the producer, not behavior.
 */

import { PARITY_REPORT_SCHEMA, type ParityReport } from './report.js';

const OUTPUT_SCHEMA_PREFIX =
  'step failed: handler output does not conform to the declared output_schema';

const METRIC_TOLERANCE = 1e-9;

function sameFailure(a: string, b: string): boolean {
  if (a.startsWith(OUTPUT_SCHEMA_PREFIX) && b.startsWith(OUTPUT_SCHEMA_PREFIX)) return true;
  return a === b;
}

export function compareReports(a: ParityReport, b: ParityReport): string[] {
  const diffs: string[] = [];
  if (a.schema !== PARITY_REPORT_SCHEMA) diffs.push(`report a: unexpected schema '${a.schema}'`);
  if (b.schema !== PARITY_REPORT_SCHEMA) diffs.push(`report b: unexpected schema '${b.schema}'`);
  if (diffs.length > 0) return diffs;

  if (a.agent_id !== b.agent_id) {
    diffs.push(`agent_id: '${a.agent_id}' != '${b.agent_id}'`);
  }
  for (const metric of ['pass_rate', 'citation_precision', 'abstention_accuracy'] as const) {
    const [ma, mb] = [a.metrics[metric], b.metrics[metric]];
    if (Math.abs(ma - mb) > METRIC_TOLERANCE) {
      diffs.push(`metrics.${metric}: ${ma} != ${mb}`);
    }
  }
  if (a.cases.length !== b.cases.length) {
    diffs.push(`case count: ${a.cases.length} != ${b.cases.length}`);
    return diffs;
  }
  for (const [i, caseA] of a.cases.entries()) {
    const caseB = b.cases[i];
    if (caseB === undefined) continue;
    if (caseA.name !== caseB.name) {
      diffs.push(`case ${i}: name '${caseA.name}' != '${caseB.name}'`);
      continue;
    }
    const label = `case '${caseA.name}'`;
    if (caseA.passed !== caseB.passed) {
      diffs.push(`${label}: passed ${caseA.passed} != ${caseB.passed}`);
    }
    if (caseA.abstained !== caseB.abstained) {
      diffs.push(`${label}: abstained ${caseA.abstained} != ${caseB.abstained}`);
    }
    if (JSON.stringify(caseA.cited_docs) !== JSON.stringify(caseB.cited_docs)) {
      diffs.push(
        `${label}: cited_docs ${JSON.stringify(caseA.cited_docs)} != ` +
          JSON.stringify(caseB.cited_docs),
      );
    }
    if (caseA.failures.length !== caseB.failures.length) {
      diffs.push(
        `${label}: failure count ${caseA.failures.length} != ${caseB.failures.length} ` +
          `(${JSON.stringify(caseA.failures)} vs ${JSON.stringify(caseB.failures)})`,
      );
      continue;
    }
    for (const [j, failureA] of caseA.failures.entries()) {
      const failureB = caseB.failures[j];
      if (failureB !== undefined && !sameFailure(failureA, failureB)) {
        diffs.push(`${label}: failure ${j}: '${failureA}' != '${failureB}'`);
      }
    }
  }
  return diffs;
}
