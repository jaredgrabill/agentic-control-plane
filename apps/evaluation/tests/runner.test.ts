import type { EvalBaseline, EvalReport } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { runAgent, runAll, type Exec, type RunDeps } from '../src/runner.js';
import type { AgentEvalEntry } from '../src/manifest.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;

const ENTRY: AgentEvalEntry = {
  agent_id: 'knowledge-agent',
  dir: 'python/agents/knowledge',
  report_command: ['uv', 'run', 'emit-report', '--out', '{out}'],
};

const MANIFEST = JSON.stringify({ schema: 'acp-eval-agents/v1', agents: [ENTRY] });

function baseline(overrides: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    schema: 'acp-eval-baseline/v1',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    suite: { digest: DIGEST, case_count: 7 },
    harness: 'acp-agent-sdk-py@0.1.0',
    recorded_at: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schema: 'acp-eval-report/v1',
    sdk: 'acp-agent-sdk-py@0.1.0',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    suite: { digest: DIGEST, case_count: 7 },
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    cases: [],
    ...overrides,
  };
}

/**
 * Fake filesystem + exec: the exec "runs the emitter" by making the report
 * appear at the {out}-substituted path, exactly like the real command would.
 */
function makeDeps(options: {
  files?: Record<string, string>;
  emitted?: unknown;
  execResult?: { code: number; stderr: string };
}): RunDeps & { execCalls: { argv: string[]; cwd: string }[] } {
  const files = new Map(Object.entries(options.files ?? {}));
  const execCalls: { argv: string[]; cwd: string }[] = [];
  const exec: Exec = (argv, cwd) => {
    execCalls.push({ argv, cwd });
    const outFlag = argv.indexOf('--out');
    const outPath = argv[outFlag + 1];
    if (options.emitted !== undefined && outPath !== undefined) {
      files.set(outPath.replaceAll('\\', '/'), JSON.stringify(options.emitted));
    }
    return Promise.resolve(options.execResult ?? { code: 0, stderr: '' });
  };
  return {
    exec,
    execCalls,
    repoRoot: '/repo',
    tmpDir: '/tmp/eval',
    readFile: (path: string) => {
      const normalized = path.replaceAll('\\', '/');
      const content = files.get(normalized);
      if (content === undefined) {
        // Mirror fs.readFileSync: missing files carry code ENOENT — the
        // runner treats ONLY that as "optional file absent".
        const err = new Error(`ENOENT: no such file, open '${normalized}'`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}

const BASELINE_PATH = '/repo/python/agents/knowledge/evals/baseline.json';
const GATE_PATH = '/repo/python/agents/knowledge/evals/gate.json';

describe('runAgent', () => {
  it('substitutes {out}, runs from the repo root, and passes a healthy run', async () => {
    const deps = makeDeps({
      files: { [BASELINE_PATH]: JSON.stringify(baseline()) },
      emitted: report(),
    });
    const result = await runAgent(ENTRY, deps);
    expect(result).toEqual({ ok: true, violations: [] });
    expect(deps.execCalls).toHaveLength(1);
    expect(deps.execCalls[0]?.cwd).toBe('/repo');
    const outArg = deps.execCalls[0]?.argv.at(-1) ?? '';
    expect(outArg.replaceAll('\\', '/')).toBe('/tmp/eval/knowledge-agent-report.json');
    expect(deps.execCalls[0]?.argv.slice(0, -1)).toEqual(['uv', 'run', 'emit-report', '--out']);
  });

  it('surfaces gate violations for a regressed run', async () => {
    const deps = makeDeps({
      files: { [BASELINE_PATH]: JSON.stringify(baseline()) },
      emitted: report({
        metrics: { pass_rate: 0.7143, citation_precision: 1, abstention_accuracy: 1 },
      }),
    });
    const result = await runAgent(ENTRY, deps);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['pass_rate 0.7143 < baseline 1.0000 − tolerance 0.05']);
  });

  it('fails actionably when no baseline is committed', async () => {
    const deps = makeDeps({ emitted: report() });
    await expect(runAgent(ENTRY, deps)).rejects.toThrow(
      /no committed baseline at .*baseline\.json — emit a report and commit one/,
    );
  });

  it('rejects a report that does not parse as acp-eval-report/v1', async () => {
    const deps = makeDeps({
      files: { [BASELINE_PATH]: JSON.stringify(baseline()) },
      emitted: { schema: 'acp-eval-report/v1', agent_id: 'knowledge-agent' },
    });
    await expect(runAgent(ENTRY, deps)).rejects.toThrow('eval-report');
  });

  it('honors a committed gate.json (zero tolerance)', async () => {
    const deps = makeDeps({
      files: {
        [BASELINE_PATH]: JSON.stringify(baseline()),
        [GATE_PATH]: JSON.stringify({ schema: 'acp-eval-gate/v1', default_tolerance: 0 }),
      },
      emitted: report({
        metrics: { pass_rate: 0.9999, citation_precision: 1, abstention_accuracy: 1 },
      }),
    });
    const result = await runAgent(ENTRY, deps);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['pass_rate 0.9999 < baseline 1.0000 − tolerance 0']);
  });

  it('fails loudly on a malformed gate.json instead of silently using builtin tolerances', async () => {
    const deps = makeDeps({
      files: {
        [BASELINE_PATH]: JSON.stringify(baseline()),
        [GATE_PATH]: '{ "default_tolerance": 0,', // truncated JSON
      },
      // A run that a zero-tolerance gate.json would reject but the builtin
      // 0.05 pass_rate tolerance would wave through — the exact silent
      // downgrade a swallowed parse error used to cause.
      emitted: report({
        metrics: { pass_rate: 0.9999, citation_precision: 1, abstention_accuracy: 1 },
      }),
    });
    await expect(runAgent(ENTRY, deps)).rejects.toThrow(/invalid gate config .*gate\.json/);
  });

  it('fails loudly on a shape-invalid gate.json', async () => {
    const deps = makeDeps({
      files: {
        [BASELINE_PATH]: JSON.stringify(baseline()),
        [GATE_PATH]: JSON.stringify({ tolerances: { pass_rate: '0.05' } }),
      },
      emitted: report(),
    });
    await expect(runAgent(ENTRY, deps)).rejects.toThrow(/invalid gate config .*gate\.json/);
  });

  it('reports a failing emitter with its exit code and stderr', async () => {
    const deps = makeDeps({
      files: { [BASELINE_PATH]: JSON.stringify(baseline()) },
      execResult: { code: 3, stderr: 'ModuleNotFoundError: knowledge_agent' },
    });
    await expect(runAgent(ENTRY, deps)).rejects.toThrow(
      'knowledge-agent report command failed (exit 3): ModuleNotFoundError: knowledge_agent',
    );
  });
});

describe('runAll', () => {
  it('summarizes a healthy roster', async () => {
    const deps = makeDeps({
      files: {
        '/repo/agents.json': MANIFEST,
        [BASELINE_PATH]: JSON.stringify(baseline()),
      },
      emitted: report(),
    });
    const { ok, lines } = await runAll('/repo/agents.json', deps);
    expect(ok).toBe(true);
    expect(lines).toEqual(['knowledge-agent: within tolerance of baseline']);
  });

  it('prefixes violations and per-agent errors with the agent id', async () => {
    const deps = makeDeps({
      files: {
        '/repo/agents.json': MANIFEST,
        [BASELINE_PATH]: JSON.stringify(baseline()),
      },
      emitted: report({
        metrics: { pass_rate: 0.5, citation_precision: 0.5, abstention_accuracy: 1 },
      }),
    });
    const { ok, lines } = await runAll('/repo/agents.json', deps);
    expect(ok).toBe(false);
    expect(lines).toEqual([
      'knowledge-agent: pass_rate 0.5000 < baseline 1.0000 − tolerance 0.05',
      'knowledge-agent: citation_precision 0.5000 < baseline 1.0000 − tolerance 0.02',
    ]);

    const broken = makeDeps({ files: { '/repo/agents.json': MANIFEST }, emitted: report() });
    const result = await runAll('/repo/agents.json', broken);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^knowledge-agent: no committed baseline/);
  });

  it('rejects a malformed roster manifest', async () => {
    const wrongSchema = makeDeps({ files: { '/repo/agents.json': '{"schema":"nope"}' } });
    await expect(runAll('/repo/agents.json', wrongSchema)).rejects.toThrow(
      'not an acp-eval-agents/v1 manifest',
    );

    const empty = makeDeps({
      files: { '/repo/agents.json': '{"schema":"acp-eval-agents/v1","agents":[]}' },
    });
    await expect(runAll('/repo/agents.json', empty)).rejects.toThrow('declares no agents');

    const malformedEntry = makeDeps({
      files: {
        '/repo/agents.json': JSON.stringify({
          schema: 'acp-eval-agents/v1',
          agents: [{ agent_id: 'x', dir: 'y', report_command: [] }],
        }),
      },
    });
    await expect(runAll('/repo/agents.json', malformedEntry)).rejects.toThrow(
      'non-empty report_command argv array',
    );
  });
});
