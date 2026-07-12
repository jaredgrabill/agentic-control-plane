/** Runs the shared parity fixtures and emits the normalized acp-parity-report/v1. */

import { join } from 'node:path';
import { Agent, EvalHarness, loadGolden } from '@acp/agent-sdk';
import { registerParityHandlers } from './handlers.js';

export interface ParityCase {
  name: string;
  passed: boolean;
  abstained: boolean;
  cited_docs: string[];
  failures: string[];
}

export interface ParityReport {
  schema: string;
  sdk: string;
  agent_id: string;
  metrics: {
    pass_rate: number;
    citation_precision: number;
    abstention_accuracy: number;
  };
  cases: ParityCase[];
}

export const PARITY_REPORT_SCHEMA = 'acp-parity-report/v1';

export async function runParity(fixturesDir: string): Promise<ParityReport> {
  const agent = Agent.fromManifest(join(fixturesDir, 'manifest.yaml'));
  registerParityHandlers(agent);
  const cases = loadGolden(join(fixturesDir, 'golden'));
  const report = await new EvalHarness(agent).run(cases);
  return {
    schema: PARITY_REPORT_SCHEMA,
    sdk: 'typescript',
    agent_id: agent.agentId,
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
  };
}
