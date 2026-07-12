import type { TaskRequest } from '@acp/protocol';

/**
 * Deterministic rule planner (v1). Pure: no IO, no clocks, no randomness —
 * step IDs and timestamps are the planTask activity's job. An LLM planner
 * later swaps in behind the same Plan schema validation; the rule table is
 * the seam, not the destination.
 */
export const RULE_PLANNER = 'rule-planner@1';

/** v0 routing rule, carried forward: unrouted questions go to the knowledge agent. */
export const DEFAULT_CAPABILITY = 'knowledge.answer_with_citations';

/** One planned step, positionally addressed — the activity assigns real step_ids. */
export interface PlanStepSpec {
  capability: string;
  input: Record<string, unknown>;
  /** Indexes into the returned array of steps that must complete first. */
  dependsOnIndex?: number[];
  rationale?: string;
}

const SPEND_WORDS = /(spend|cost)/;
const ANOMALY_WORDS = /(jump|spike|rose|increas|anomal|why)/;

/**
 * Exactly three plan shapes (normative), first match wins:
 *
 * 1. Explicit route — the caller named a capability; one step with the v0
 *    input mapping, byte for byte.
 * 2. Cost-spike forensics composite — cost/spend anomaly questions fan out
 *    to cloud.cost_analysis plus (when a repo is in context) code.ci_health,
 *    independent steps dispatched in parallel.
 * 3. Default — one knowledge step, the v0 behavior. Applied even when the
 *    capability is unservable: dispatch produces the existing honest
 *    failure. The planner is total; it never throws.
 */
export function buildPlanSteps(task: TaskRequest, servable: ReadonlySet<string>): PlanStepSpec[] {
  const explicit = task.input.capability;
  if (explicit !== undefined) {
    return [{ capability: explicit, input: explicitInput(task, explicit) }];
  }

  // 1.5 Explicit sequence — the caller named an ordered list of 2-5
  // capabilities in context.sequence; each depends on the previous (a
  // sequential chain), input taken positionally from context.inputs. Every
  // step still clears the Plan schema and the per-step delegation policy — the
  // sequence grants no new authority, it only shapes the plan (needed for
  // change-then-verify flows and the compensation E2E slice).
  const sequence = sequenceOf(task);
  if (sequence !== undefined) {
    const inputs = (task.input.context as Record<string, unknown> | undefined)?.inputs;
    const inputAt = (i: number): Record<string, unknown> => {
      const supplied = Array.isArray(inputs) ? (inputs[i] as unknown) : undefined;
      return typeof supplied === 'object' && supplied !== null
        ? (supplied as Record<string, unknown>)
        : { text: task.input.text };
    };
    return sequence.map((capability, i) => ({
      capability,
      input: inputAt(i),
      ...(i === 0 ? {} : { dependsOnIndex: [i - 1] }),
      rationale: `sequence step ${i + 1} of ${sequence.length}: ${capability}`,
    }));
  }

  const text = task.input.text.toLowerCase();
  if (SPEND_WORDS.test(text) && ANOMALY_WORDS.test(text) && servable.has('cloud.cost_analysis')) {
    const steps: PlanStepSpec[] = [
      {
        capability: 'cloud.cost_analysis',
        input: {},
        rationale: 'attribute the spend change to a service and deploy',
      },
    ];
    const repo = (task.input.context as Record<string, unknown> | undefined)?.repo;
    if (typeof repo === 'string' && servable.has('code.ci_health')) {
      // Independent of the cost step — parallel fan-out, no depends_on.
      steps.push({
        capability: 'code.ci_health',
        input: { repo },
        rationale: 'correlate CI/deploy activity for the implicated repo',
      });
    }
    // No knowledge step in v1: the extractive agent would abstain on this
    // question shape and manufacture a gap. Three-agent composition arrives
    // with the LLM planner.
    return steps;
  }

  return [{ capability: DEFAULT_CAPABILITY, input: { question: task.input.text } }];
}

/** A well-formed context.sequence: 2-5 capability-shaped strings, else undefined. */
function sequenceOf(task: TaskRequest): string[] | undefined {
  const raw = (task.input.context as Record<string, unknown> | undefined)?.sequence;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) return undefined;
  if (!raw.every((c) => typeof c === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(c))) {
    return undefined;
  }
  return raw as string[];
}

/** The v0 input mapping for an explicitly routed capability — byte for byte. */
function explicitInput(task: TaskRequest, capability: string): Record<string, unknown> {
  return capability === DEFAULT_CAPABILITY
    ? { question: task.input.text }
    : ((task.input.context as Record<string, unknown> | undefined) ?? { text: task.input.text });
}
