import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A committed judging rubric. v0 rubrics are files under packages/judge/rubrics
 * (registry-stored judge artifacts are deferred). The digest — sha256 over the
 * rubric text with line endings normalized to LF — rides in every eval.score,
 * so a replay can prove which exact rubric produced a verdict even after the
 * text changes. Normalizing CRLF→LF keeps the digest identical on Windows
 * checkouts (git may materialize CRLF) and Linux CI.
 */
export interface Rubric {
  /** Rubric id, e.g. 'answer-quality@1'. */
  id: string;
  /** The full rubric text (the judge's user-role instruction block). */
  text: string;
  /** sha256:<hex> over the LF-normalized text. */
  digest: string;
}

/** The one v0 rubric. Extend as more judged dimensions are added. */
export const KNOWN_RUBRICS = ['answer-quality@1'] as const;
export type RubricId = (typeof KNOWN_RUBRICS)[number];

/** Where the committed rubric markdown lives, relative to the compiled module. */
function rubricPath(id: string): URL {
  // dist/rubric.js → ../rubrics/<id>.md (rubrics ships in the package `files`).
  return new URL(`../rubrics/${id}.md`, import.meta.url);
}

export function rubricDigest(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

/**
 * Loads a committed rubric by id. Throws if the id is unknown — a typo must
 * never silently fall through to scoring against no rubric.
 */
export function loadRubric(id: string): Rubric {
  if (!(KNOWN_RUBRICS as readonly string[]).includes(id)) {
    throw new Error(`unknown rubric ${JSON.stringify(id)} — known: ${KNOWN_RUBRICS.join(', ')}`);
  }
  const text = readFileSync(fileURLToPath(rubricPath(id)), 'utf8');
  return { id, text, digest: rubricDigest(text) };
}
