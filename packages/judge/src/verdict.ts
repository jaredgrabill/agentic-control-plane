import { Ajv, type ValidateFunction } from 'ajv';

export const VERDICT_SCHEMA_ID = 'acp-judge-verdict/v1';

/** The app-local wire shape a judge completion must return. */
export interface JudgeVerdict {
  schema: 'acp-judge-verdict/v1';
  /** Quality score in [0,1]; clamped on parse. */
  score: number;
  verdict: 'pass' | 'fail';
  reasons: string[];
}

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
const validateVerdict: ValidateFunction = ajv.compile({
  type: 'object',
  required: ['schema', 'score', 'verdict', 'reasons'],
  additionalProperties: true,
  properties: {
    schema: { const: VERDICT_SCHEMA_ID },
    score: { type: 'number' },
    verdict: { enum: ['pass', 'fail'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
});

/**
 * Result of parsing a judge completion. A parse that cannot yield a valid
 * verdict is `unparseable_verdict` — a JUDGE error, never an agent quality
 * observation: it must not burn the agent's error budget (the caller ingests
 * no score for it).
 */
export type VerdictParse =
  | { ok: true; verdict: JudgeVerdict }
  | { ok: false; outcome: 'unparseable_verdict'; detail: string };

/**
 * Extracts the first balanced top-level JSON object from arbitrary text.
 * dev-echo returns a clean payload, but a real provider may wrap the verdict
 * in prose or a ```json fence — this tolerates leading/trailing junk by
 * scanning for the first `{` and matching braces (respecting string literals
 * and escapes so a `}` inside a string does not close the object early).
 */
export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Parses a judge completion's raw text into a verdict, clamping the score to
 * [0,1] and reconciling `verdict` with the 0.7 pass threshold (a provider that
 * returns score 0.9 + verdict 'fail' is a contradiction; the score is the
 * ground truth, so verdict is recomputed). Returns unparseable_verdict when no
 * balanced JSON object validates.
 */
export function parseVerdict(rawText: string): VerdictParse {
  const json = extractFirstJsonObject(rawText);
  if (json === undefined) {
    return { ok: false, outcome: 'unparseable_verdict', detail: 'no JSON object in completion' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      outcome: 'unparseable_verdict',
      detail: `verdict JSON did not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!validateVerdict(parsed)) {
    return {
      ok: false,
      outcome: 'unparseable_verdict',
      detail: `verdict failed schema: ${ajv.errorsText(validateVerdict.errors)}`,
    };
  }
  const v = parsed as JudgeVerdict;
  const score = clamp01(v.score);
  return {
    ok: true,
    verdict: {
      schema: VERDICT_SCHEMA_ID,
      score,
      verdict: score >= 0.7 ? 'pass' : 'fail',
      reasons: v.reasons,
    },
  };
}

/** The pass threshold: a judged sample below this is a bad quality observation. */
export const PASS_THRESHOLD = 0.7;
