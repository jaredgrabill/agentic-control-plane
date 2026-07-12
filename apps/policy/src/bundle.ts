import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PolicyBundle {
  /** Stable policy id (from the @id annotation) → policy text. */
  policies: Record<string, string>;
  /**
   * Ids of permit policies carrying `@decision("require-approval")`. Cedar
   * stays two-verdict in-engine; the PDP lifts an allow determined by any of
   * these into a three-way require-approval (see pdp.ts). A closed set built
   * at load time so a determining-policy lookup is O(1) per decision.
   */
  approvalPolicies: Set<string>;
  version: string;
}

const ID_ANNOTATION = /@id\("([A-Za-z0-9_-]+)"\)/;
const DECISION_ANNOTATION = /@decision\("([^"]*)"\)/;
/** The only @decision value the loader accepts; anything else is a bundle error. */
const REQUIRE_APPROVAL = 'require-approval';
/** The policy effect keyword, after any leading annotations. */
const EFFECT = /\b(permit|forbid)\s*\(/;

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
  const approvalPolicies = new Set<string>();
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

    // A @decision annotation lifts an allow this policy determines into a
    // three-way decision. It is only meaningful on a permit — annotating a
    // forbid is a governance mistake (a deny is never rescued into an
    // approval), and an unknown value would silently no-op. Both are load
    // errors: a policy that looks like it gates but doesn't must never ship.
    const decision = DECISION_ANNOTATION.exec(text)?.[1];
    if (decision !== undefined) {
      if (decision !== REQUIRE_APPROVAL) {
        throw new Error(
          `${file} declares @decision("${decision}") — the only supported value is ` +
            `"${REQUIRE_APPROVAL}"`,
        );
      }
      if (EFFECT.exec(text)?.[1] !== 'permit') {
        throw new Error(
          `${file} carries @decision("${REQUIRE_APPROVAL}") on a non-permit policy — the ` +
            'annotation only lifts permits; a forbid or no-permit already denies',
        );
      }
      approvalPolicies.add(id);
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
  return { policies, approvalPolicies, version: `${versionPrefix}+${contentHash}` };
}
