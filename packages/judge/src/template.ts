import type { CompletionPrompt, CompletionRequest } from '@acp/llm-client';
import type { Rubric } from './rubric.js';
import { VERDICT_SCHEMA_ID } from './verdict.js';

/** The thing being judged: a task input, the candidate answer, its citations. */
export interface JudgeSample {
  input: string;
  output: string;
  citations?: string[];
}

/** Inputs longer than this are truncated (the judge sees the head, which carries the ask). */
export const MAX_INPUT_CHARS = 4000;
/** Candidate outputs longer than this are truncated. */
export const MAX_OUTPUT_CHARS = 16000;

/** The static system block: judge role, verdict contract, and scale. Byte-stable. */
const SYSTEM_BLOCK =
  'You are a strict evaluation judge. You are given a RUBRIC, then a TASK INPUT, ' +
  'a CANDIDATE OUTPUT, and the CITATIONS the candidate returned. Score the candidate ' +
  'strictly by the rubric using only the material provided.\n\n' +
  `Return ONLY a single JSON object, no prose, of the form ` +
  `{"schema":"${VERDICT_SCHEMA_ID}","score":<number 0..1>,"verdict":"pass"|"fail","reasons":[<strings>]}. ` +
  'score is a number in [0,1]; verdict is "pass" when score >= 0.7 else "fail".';

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/**
 * Builds the judge completion prompt. The static prefix (system contract +
 * rubric) is byte-stable per rubric, so the LLM gateway's prefix cache hits
 * across every verdict for that rubric ("one rubric, two venues" enforced
 * structurally — offline eval and online scoring call THIS function). The
 * volatile tail carries the sample under judgement.
 *
 * NOTE for dev-echo: the CANDIDATE OUTPUT is placed at line-start in a
 * variable block, so an answer that embeds a `[[dev-llm]] {...}` verdict line
 * (the E2E scripted-verdict trick) is the first directive line the dev
 * provider echoes back verbatim.
 */
export function buildJudgePrompt(rubric: Rubric, sample: JudgeSample): CompletionPrompt {
  const citations =
    sample.citations !== undefined && sample.citations.length > 0
      ? sample.citations.join('\n')
      : '(no citations returned)';
  const sampleBlock =
    `TASK INPUT:\n${truncate(sample.input, MAX_INPUT_CHARS)}\n\n` +
    `CANDIDATE OUTPUT:\n${truncate(sample.output, MAX_OUTPUT_CHARS)}\n\n` +
    `CITATIONS:\n${citations}`;
  return {
    static: [
      { role: 'system', text: SYSTEM_BLOCK },
      { role: 'user', text: `RUBRIC:\n${rubric.text}` },
    ],
    variable: [
      { role: 'user', text: sampleBlock },
      { role: 'user', text: 'Return only the JSON verdict.' },
    ],
  };
}

/** Builds the full completion request (prompt + judge metadata + model class). */
export function buildJudgeRequest(
  rubric: Rubric,
  sample: JudgeSample,
  modelClass: string,
): CompletionRequest {
  return {
    model_class: modelClass,
    prompt: buildJudgePrompt(rubric, sample),
    max_tokens: 512,
    temperature: 0,
    metadata: { purpose: 'judge' },
  };
}
