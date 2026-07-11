/**
 * Per-agent orchestration: run each roster entry's report emitter, load the
 * committed baseline (and optional gate.json), and apply the gate. All
 * process/filesystem access is injected so the decision logic is unit-tested
 * without spawning anything.
 */

import { join } from 'node:path';
import { evalBaseline, evalReport } from '@acp/protocol';
import { applyGate, type GateConfig, type GateResult } from './gate.js';
import { loadManifest, type AgentEvalEntry } from './manifest.js';

export type Exec = (argv: string[], cwd: string) => Promise<{ code: number; stderr: string }>;

export interface RunDeps {
  exec: Exec;
  repoRoot: string;
  readFile: (path: string) => string;
  tmpDir: string;
}

/** Runs one agent's suite and gates the fresh report against its committed baseline. */
export async function runAgent(entry: AgentEvalEntry, deps: RunDeps): Promise<GateResult> {
  const baselinePath = join(deps.repoRoot, entry.dir, 'evals', 'baseline.json');
  let baselineText: string;
  try {
    baselineText = deps.readFile(baselinePath);
  } catch {
    throw new Error(
      `no committed baseline at ${baselinePath} — emit a report and commit one: ` +
        'node apps/evaluation/dist/main.js baseline --report <report> --out ' +
        `${entry.dir}/evals/baseline.json`,
    );
  }
  const baseline = evalBaseline.parse(JSON.parse(baselineText));

  const outPath = join(deps.tmpDir, `${entry.agent_id}-report.json`);
  const argv = entry.report_command.map((arg) => arg.replaceAll('{out}', outPath));
  const { code, stderr } = await deps.exec(argv, deps.repoRoot);
  if (code !== 0) {
    throw new Error(`${entry.agent_id} report command failed (exit ${code}): ${stderr}`);
  }
  const report = evalReport.parse(JSON.parse(deps.readFile(outPath)));

  const gatePath = join(deps.repoRoot, entry.dir, 'evals', 'gate.json');
  let config: GateConfig | undefined;
  try {
    config = JSON.parse(deps.readFile(gatePath)) as GateConfig;
  } catch {
    // gate.json is optional; builtin tolerances apply.
  }
  return applyGate(baseline, report, config);
}

/** Gates every agent on the roster; `lines` is the human-readable per-agent summary. */
export async function runAll(
  manifestPath: string,
  deps: RunDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const manifest = loadManifest(manifestPath, deps.readFile);
  const lines: string[] = [];
  let ok = true;
  for (const entry of manifest.agents) {
    let result: GateResult;
    try {
      result = await runAgent(entry, deps);
    } catch (err) {
      ok = false;
      lines.push(`${entry.agent_id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (result.ok) {
      lines.push(`${entry.agent_id}: within tolerance of baseline`);
    } else {
      ok = false;
      lines.push(...result.violations.map((violation) => `${entry.agent_id}: ${violation}`));
    }
  }
  return { ok, lines };
}
