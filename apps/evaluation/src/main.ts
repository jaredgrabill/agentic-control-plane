#!/usr/bin/env node
/**
 * Evaluation Service v0 CLI:
 *   run      --manifest <agents.json>                      run every roster agent's suite and gate it
 *   gate     --report <f> --baseline <f> [--gates <f>]     gate one report against one baseline
 *   baseline --report <f> --out <f>                        distill an accepted report into a baseline
 *   record   --baseline <f> --registry <url> --token-url <url> --client-id <id> --client-secret <s>
 *
 * Exit 0 on pass; exit 1 with one violation per stderr line.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evalBaseline, evalReport } from '@acp/protocol';
import { baselineFromReport } from './baseline.js';
import { applyGate, type GateConfig } from './gate.js';
import { recordBaseline } from './registry-client.js';
import { runAll, type Exec } from './runner.js';

const USAGE = [
  'usage: main.js run --manifest <agents.json>',
  '     | main.js gate --report <file> --baseline <file> [--gates <file>]',
  '     | main.js baseline --report <file> --out <file>',
  '     | main.js record --baseline <file> --registry <url> --token-url <url> --client-id <id> --client-secret <secret>',
].join('\n');

const exec: Exec = (argv, cwd) =>
  new Promise((resolvePromise) => {
    const [command, ...args] = argv;
    execFile(
      command ?? '',
      args,
      // Same rationale as packages/protocol/scripts/generate.mjs: `uv` and
      // friends resolve through the shell on Windows dev machines.
      { cwd, shell: process.platform === 'win32' },
      (err, _stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolvePromise({ code, stderr });
      },
    );
  });

function required(values: Record<string, string | undefined>, names: string[]): string[] {
  const missing = names.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    process.stderr.write(`missing --${missing.join(', --')}\n${USAGE}\n`);
  }
  return missing;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'run') {
    const { values } = parseArgs({ args: rest, options: { manifest: { type: 'string' } } });
    if (required(values, ['manifest']).length > 0) return 2;
    const { ok, lines } = await runAll(resolve(values.manifest ?? ''), {
      exec,
      repoRoot: process.cwd(),
      readFile: (path) => readFileSync(path, 'utf-8'),
      tmpDir: mkdtempSync(join(tmpdir(), 'acp-eval-')),
    });
    for (const line of lines) (ok ? process.stdout : process.stderr).write(`${line}\n`);
    if (!ok) return 1;
    process.stdout.write(`eval gate: ${lines.length} agent(s) within tolerance\n`);
    return 0;
  }

  if (command === 'gate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        report: { type: 'string' },
        baseline: { type: 'string' },
        gates: { type: 'string' },
      },
    });
    if (required(values, ['report', 'baseline']).length > 0) return 2;
    const report = evalReport.parse(JSON.parse(readFileSync(values.report ?? '', 'utf-8')));
    const baseline = evalBaseline.parse(JSON.parse(readFileSync(values.baseline ?? '', 'utf-8')));
    const config =
      values.gates === undefined
        ? undefined
        : (JSON.parse(readFileSync(values.gates, 'utf-8')) as GateConfig);
    const result = applyGate(baseline, report, config);
    if (!result.ok) {
      for (const violation of result.violations) process.stderr.write(`${violation}\n`);
      return 1;
    }
    process.stdout.write(`eval gate: ${report.agent_id} within tolerance of baseline\n`);
    return 0;
  }

  if (command === 'baseline') {
    const { values } = parseArgs({
      args: rest,
      options: { report: { type: 'string' }, out: { type: 'string' } },
    });
    if (required(values, ['report', 'out']).length > 0) return 2;
    const report = evalReport.parse(JSON.parse(readFileSync(values.report ?? '', 'utf-8')));
    const baseline = evalBaseline.parse(baselineFromReport(report));
    writeFileSync(values.out ?? '', `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    process.stdout.write(`wrote ${values.out ?? ''}\n`);
    return 0;
  }

  if (command === 'record') {
    const { values } = parseArgs({
      args: rest,
      options: {
        baseline: { type: 'string' },
        registry: { type: 'string' },
        'token-url': { type: 'string' },
        'client-id': { type: 'string' },
        'client-secret': { type: 'string' },
      },
    });
    if (
      required(values, ['baseline', 'registry', 'token-url', 'client-id', 'client-secret']).length >
      0
    ) {
      return 2;
    }
    const baseline = evalBaseline.parse(JSON.parse(readFileSync(values.baseline ?? '', 'utf-8')));
    const card = await recordBaseline({
      registryUrl: values.registry ?? '',
      tokenUrl: values['token-url'] ?? '',
      clientId: values['client-id'] ?? '',
      clientSecret: values['client-secret'] ?? '',
      baseline,
    });
    process.stdout.write(
      `recorded baseline for ${baseline.agent_id}@${baseline.agent_version} ` +
        `(card updated_at ${card.updated_at})\n`,
    );
    return 0;
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
