/**
 * agents.json: the roster of agents the eval gate runs against. TS-local
 * config (never crosses a language boundary), so a hand-written interface
 * plus structural checks is the right weight — no protocol schema.
 *
 * Conventions per entry, relative to the repo root:
 *   - golden suite at   <dir>/evals/golden/
 *   - committed baseline <dir>/evals/baseline.json   (required)
 *   - tolerance config   <dir>/evals/gate.json       (optional)
 * report_command is an argv array (no shell), run from the repo root, with
 * `{out}` replaced by a temp file path the emitter must write the
 * acp-eval-report/v1 document to.
 */

export interface AgentEvalEntry {
  agent_id: string;
  dir: string;
  report_command: string[];
}

export interface EvalAgentsManifest {
  schema: 'acp-eval-agents/v1';
  agents: AgentEvalEntry[];
}

export function loadManifest(path: string, readFile: (p: string) => string): EvalAgentsManifest {
  const doc: unknown = JSON.parse(readFile(path));
  const manifest = doc as Partial<EvalAgentsManifest>;
  if (manifest.schema !== 'acp-eval-agents/v1') {
    throw new Error(`${path} is not an acp-eval-agents/v1 manifest`);
  }
  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    throw new Error(`${path} declares no agents — an empty eval roster gates nothing`);
  }
  for (const entry of manifest.agents) {
    if (
      typeof entry.agent_id !== 'string' ||
      typeof entry.dir !== 'string' ||
      !Array.isArray(entry.report_command) ||
      entry.report_command.length === 0 ||
      !entry.report_command.every((arg) => typeof arg === 'string')
    ) {
      throw new Error(
        `${path}: every agent needs agent_id, dir, and a non-empty report_command argv array`,
      );
    }
  }
  return manifest as EvalAgentsManifest;
}
