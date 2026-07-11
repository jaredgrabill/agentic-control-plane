import type { Answer, CapabilityError, Citation, PlanStep, StepResult } from '@acp/protocol';

/**
 * Deterministic synthesis (v1). Pure and isolate-safe — this module runs
 * inside the workflow sandbox. Composition is mechanical: attribution,
 * citation renumbering, honest gaps. NEVER synthesized content for a
 * missing step.
 */

/** One plan step's outcome as the parent workflow recorded it, in plan order. */
export interface StepOutcome {
  planStep: PlanStep;
  /** Known only when the caller resolved the serving agent (tests, future planners with pins). */
  agent?: { agentId: string; agentVersion: string } | undefined;
  /** Absent when the step was skipped (dependency failure or budget exhaustion). */
  result?: StepResult | undefined;
  /** The full gap sentence recorded when the step was skipped. */
  skipReason?: string | undefined;
}

export interface SynthesizedResult {
  status: 'completed' | 'partial' | 'failed';
  answer?: Answer;
  gaps: string[];
  error?: CapabilityError;
}

/**
 * Folds step outcomes into one terminal result:
 *
 * - every completed step must carry an Answer envelope (structural guard —
 *   Ajv cannot run in the isolate); a non-conforming output is a failed step
 * - single-step plans pass the answer through untouched (v0 parity)
 * - multi-step plans concatenate sections in plan order, each prefixed with
 *   an attribution line, inline [n] markers renumbered by the running
 *   citation offset; citations concatenate without deduplication;
 *   confidence is the MIN over completed steps
 * - status: all completed → completed; some → partial with mandatory gaps;
 *   none → failed with the first failed step's error
 */
export function synthesizeAnswer(outcomes: StepOutcome[]): SynthesizedResult {
  const gaps: string[] = [];
  const completed: { outcome: StepOutcome; answer: Answer }[] = [];
  let firstError: CapabilityError | undefined;

  for (const outcome of outcomes) {
    const { planStep, agent, result, skipReason } = outcome;
    if (result === undefined) {
      gaps.push(skipReason ?? `${planStep.capability}: skipped`);
      continue;
    }
    if (result.status === 'completed') {
      const answer = asAnswer(result.output);
      if (answer !== null) {
        completed.push({ outcome, answer });
        continue;
      }
      // A "completed" step without a well-formed Answer is a failed step:
      // passing opaque output onward would be silent backfill territory.
      const gap = `${planStep.capability}: step output was not an Answer envelope`;
      gaps.push(gap);
      firstError ??= { class: 'permanent', message: gap };
      continue;
    }
    const reason = result.error?.message ?? 'step returned no output';
    gaps.push(`${planStep.capability}${agent ? ` (${agent.agentId})` : ''}: ${reason}`);
    firstError ??= result.error ?? { class: 'permanent', message: reason };
  }

  const [first] = completed;
  if (first === undefined) {
    return {
      status: 'failed',
      gaps,
      error: firstError ?? { class: 'permanent', message: 'no step produced output' },
    };
  }

  const answer = outcomes.length === 1 ? first.answer : composeSections(completed);
  const status = gaps.length === 0 ? 'completed' : 'partial';
  return { status, answer, gaps };
}

/** Multi-step composition: attribution headers, marker renumbering, no citation dedup, min confidence. */
function composeSections(completed: { outcome: StepOutcome; answer: Answer }[]): Answer {
  const sections: string[] = [];
  const citations: Citation[] = [];
  let confidence = 1;

  for (const { outcome, answer } of completed) {
    const offset = citations.length;
    const text =
      offset === 0
        ? answer.text
        : answer.text.replace(/\[(\d+)\]/g, (_, n: string) => `[${Number(n) + offset}]`);
    sections.push(`${attributionLine(outcome)}\n${text}`);
    citations.push(...answer.citations);
    confidence = Math.min(confidence, answer.confidence);
  }

  return { text: sections.join('\n\n'), citations, confidence };
}

function attributionLine(outcome: StepOutcome): string {
  const capability = outcome.planStep.capability;
  return outcome.agent === undefined
    ? `[${capability}]`
    : `[${capability} — ${outcome.agent.agentId}@${outcome.agent.agentVersion}]`;
}

/**
 * Structural Answer guard: the workflow isolate cannot run Ajv, so the
 * envelope check is shape-only — text, citations[], numeric confidence.
 */
function asAnswer(output: unknown): Answer | null {
  if (typeof output !== 'object' || output === null) return null;
  const candidate = output as Record<string, unknown>;
  if (typeof candidate.text !== 'string') return null;
  if (!Array.isArray(candidate.citations)) return null;
  if (typeof candidate.confidence !== 'number') return null;
  return output as Answer;
}
