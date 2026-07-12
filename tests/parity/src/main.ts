#!/usr/bin/env node
/**
 * Parity harness CLI:
 *   run --fixtures <dir> --out <file>   emit the TypeScript report
 *   compare <a.json> <b.json>           diff two reports; exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compareReports } from './compare.js';
import { runParity, type ParityReport } from './report.js';

const USAGE =
  'usage: main.js run --fixtures <dir> --out <file> | main.js compare <a.json> <b.json>';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: { fixtures: { type: 'string' }, out: { type: 'string' } },
    });
    if (values.fixtures === undefined || values.out === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const report = await runParity(values.fixtures);
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    process.stdout.write(`wrote ${values.out}\n`);
    return 0;
  }
  if (command === 'compare') {
    const [pathA, pathB] = rest;
    if (pathA === undefined || pathB === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const reportA = JSON.parse(readFileSync(pathA, 'utf-8')) as ParityReport;
    const reportB = JSON.parse(readFileSync(pathB, 'utf-8')) as ParityReport;
    const diffs = compareReports(reportA, reportB);
    if (diffs.length > 0) {
      for (const diff of diffs) process.stderr.write(`${diff}\n`);
      return 1;
    }
    process.stdout.write(`parity: reports match (${reportA.cases.length} cases)\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
