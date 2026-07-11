/** The testable core of the CLI: argv → exit code, files on disk. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { renderTemplate } from './template.js';

const USAGE = 'usage: create-agent <name> [--owner <team>] [--dir <parent>]';
const NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export function scaffold(argv: string[]): number {
  let positionals: string[];
  let values: { owner?: string; dir?: string };
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        owner: { type: 'string' },
        dir: { type: 'string' },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
    return 2;
  }
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!NAME_RE.test(name)) {
    process.stderr.write(
      `agent name '${name}' must be kebab-case (^[a-z][a-z0-9-]{1,62}[a-z0-9]$)\n`,
    );
    return 2;
  }

  const target = join(values.dir ?? '.', name);
  if (existsSync(target)) {
    process.stderr.write(`${target} already exists — refusing to overwrite\n`);
    return 2;
  }

  const files = renderTemplate(name, values.owner ?? 'team-CHANGEME');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(target, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }

  process.stdout.write(`scaffolded ${name} at ${target}\n`);
  process.stdout.write(`next: cd ${target} && pnpm install && pnpm test\n`);
  return 0;
}
