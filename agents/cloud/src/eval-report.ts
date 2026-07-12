/**
 * Eval report emitter for the Evaluation Service roster (apps/evaluation):
 * runs the golden suite hermetically (fixture tools over in-memory MCP) and
 * writes an acp-eval-report/v1 document.
 *
 * CLI: node agents/cloud/dist/eval-report.js --out <file>
 */

import console from 'node:console';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Agent, EvalHarness, loadGolden, reportPayload, type EvalReport } from '@acp/agent-sdk';
import { noRetriever } from '@acp/tool-client';
import { registerCapabilities } from './capabilities/index.js';
import { fixtureToolClient } from './fixture-tools.js';

export const AGENT_ID = 'cloud-agent';
/** Must equal the version the E2E suite registers. */
export const AGENT_VERSION = '0.1.0';

const MANIFEST_PATH = fileURLToPath(new URL('../manifest.yaml', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('../evals/golden', import.meta.url));

export async function buildReport(): Promise<{
  report: EvalReport;
  payload: ReturnType<typeof reportPayload>;
}> {
  const agent = Agent.fromManifest(MANIFEST_PATH, { retriever: noRetriever(AGENT_ID) });
  registerCapabilities(agent, { tools: fixtureToolClient() });
  const harness = new EvalHarness(agent, { delegatedToken: 'eval-token' });
  const report = await harness.run(loadGolden(GOLDEN_DIR));
  const payload = reportPayload(report, {
    agentId: AGENT_ID,
    agentVersion: AGENT_VERSION,
    suiteDir: GOLDEN_DIR,
  });
  return { report, payload };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' } },
  });
  if (values.out === undefined) {
    console.error('usage: eval-report --out <file>');
    return 2;
  }
  const { report, payload } = await buildReport();
  writeFileSync(values.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(report.summary());
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
