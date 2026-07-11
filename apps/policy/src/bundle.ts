import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PolicyBundle {
  /** Stable policy id (from the @id annotation) → policy text. */
  policies: Record<string, string>;
  version: string;
}

const ID_ANNOTATION = /@id\("([A-Za-z0-9_-]+)"\)/;

/**
 * Loads a git-versioned bundle directory: one policy per .cedar file, each
 * carrying an @id annotation that matches its filename — decision
 * diagnostics and audit records reference these stable ids, so anonymous
 * policies are a loading error, not a style nit.
 */
export function loadBundle(dir: string): PolicyBundle {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.cedar'))
    .sort();
  if (files.length === 0) {
    throw new Error(`policy bundle directory ${dir} contains no .cedar files`);
  }
  const policies: Record<string, string> = {};
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const id = ID_ANNOTATION.exec(text)?.[1];
    if (id === undefined) {
      throw new Error(
        `${file} has no @id("...") annotation — audit records need stable policy ids`,
      );
    }
    if (id !== file.replace('.cedar', '')) {
      throw new Error(`${file} declares @id("${id}") — the id must match the filename`);
    }
    if (id in policies) {
      throw new Error(`duplicate policy id ${id}`);
    }
    policies[id] = text;
  }

  const contentHash = createHash('sha256')
    .update(files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'))
    .digest('hex')
    .slice(0, 12);
  let versionPrefix = 'dev';
  try {
    versionPrefix = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  } catch {
    // VERSION file is optional; the content hash alone still pins the bundle.
  }
  return { policies, version: `${versionPrefix}+${contentHash}` };
}
