import type { Answer, PlanStep, StepResult } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { synthesizeAnswer, type StepOutcome } from '../src/synthesis.js';

const STEP_IDS = [
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f52',
  '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f53',
];

function planStep(index: number, capability: string): PlanStep {
  return { step_id: STEP_IDS[index]!, capability, input: {} };
}

function completedResult(index: number, output: Record<string, unknown>): StepResult {
  return {
    kind: 'step_result',
    step_id: STEP_IDS[index]!,
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    status: 'completed',
    output,
  };
}

function failedResult(index: number, error: NonNullable<StepResult['error']>): StepResult {
  return {
    kind: 'step_result',
    step_id: STEP_IDS[index]!,
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    status: 'failed',
    error,
  };
}

const costAnswer: Answer = {
  text: 'Total spend rose 30.0% week over week [1], driven by payments-api [2].',
  citations: [
    { doc_id: 'cloud/cost-report', version: '2026-07-08', lineage_id: STEP_IDS[0]! },
    { doc_id: 'cloud/inventory-snapshot', version: '2026-07-08', lineage_id: STEP_IDS[1]! },
  ],
  confidence: 0.8,
};

const ciAnswer: Answer = {
  text: 'Pass rate dipped after deploy d-2026-07-01-042 [1].',
  citations: [{ doc_id: 'code/ci-activity', version: '2026-07-08', lineage_id: STEP_IDS[2]! }],
  confidence: 0.9,
};

describe('single-step plans', () => {
  it('passes the answer through untouched — v0 parity, no attribution header', () => {
    const result = synthesizeAnswer([
      {
        planStep: planStep(0, 'cloud.cost_analysis'),
        result: completedResult(0, costAnswer as unknown as Record<string, unknown>),
      },
    ]);
    expect(result.status).toBe('completed');
    expect(result.answer).toEqual(costAnswer);
    expect(result.gaps).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('guards the envelope shape strictly: text, citations[], numeric confidence', () => {
    const badOutputs: unknown[] = [
      undefined,
      null,
      'plain string',
      { text: 1, citations: [], confidence: 0.5 },
      { text: 'x', citations: 'nope', confidence: 0.5 },
      { text: 'x', citations: [], confidence: 'high' },
    ];
    for (const output of badOutputs) {
      const result = synthesizeAnswer([
        {
          planStep: planStep(0, 'cloud.cost_analysis'),
          result: {
            kind: 'step_result',
            step_id: STEP_IDS[0]!,
            task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
            tenant: 'acme',
            status: 'completed',
            ...(output === undefined ? {} : { output: output as Record<string, unknown> }),
          },
        },
      ]);
      expect(result.status, JSON.stringify(output)).toBe('failed');
      expect(result.gaps[0]).toContain('not an Answer envelope');
    }
  });

  it('falls back to a generic reason when a failed step carries no error object', () => {
    const result = synthesizeAnswer([
      {
        planStep: planStep(0, 'cloud.cost_analysis'),
        result: {
          kind: 'step_result',
          step_id: STEP_IDS[0]!,
          task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
          tenant: 'acme',
          status: 'failed',
        },
      },
    ]);
    expect(result.status).toBe('failed');
    expect(result.gaps).toEqual(['cloud.cost_analysis: step returned no output']);
    expect(result.error).toEqual({
      class: 'permanent',
      message: 'step returned no output',
    });
  });

  it('records a minimal gap for an outcome with neither result nor recorded reason', () => {
    const result = synthesizeAnswer([{ planStep: planStep(0, 'cloud.cost_analysis') }]);
    expect(result.status).toBe('failed');
    expect(result.gaps).toEqual(['cloud.cost_analysis: skipped']);
    expect(result.error).toEqual({ class: 'permanent', message: 'no step produced output' });
  });

  it('treats a non-Answer output as a failed step with the envelope gap', () => {
    const result = synthesizeAnswer([
      {
        planStep: planStep(0, 'cloud.cost_analysis'),
        result: completedResult(0, { rows: [1, 2, 3] }),
      },
    ]);
    expect(result.status).toBe('failed');
    expect(result.answer).toBeUndefined();
    expect(result.gaps).toEqual(['cloud.cost_analysis: step output was not an Answer envelope']);
    expect(result.error?.message).toContain('not an Answer envelope');
  });
});

describe('multi-step composition', () => {
  const outcomes: StepOutcome[] = [
    {
      planStep: planStep(0, 'cloud.cost_analysis'),
      agent: { agentId: 'cloud-agent', agentVersion: '0.1.0' },
      result: completedResult(0, costAnswer as unknown as Record<string, unknown>),
    },
    {
      planStep: planStep(1, 'code.ci_health'),
      agent: { agentId: 'code-agent', agentVersion: '0.1.0' },
      result: completedResult(1, ciAnswer as unknown as Record<string, unknown>),
    },
  ];

  it('joins attributed sections, renumbers markers by the citation offset, concatenates citations', () => {
    const result = synthesizeAnswer(outcomes);
    expect(result.status).toBe('completed');

    const sections = result.answer!.text.split('\n\n');
    expect(sections[0]).toBe(`[cloud.cost_analysis — cloud-agent@0.1.0]\n${costAnswer.text}`);
    // The CI section's [1] becomes [3]: two cost citations precede it.
    expect(sections[1]).toBe(
      '[code.ci_health — code-agent@0.1.0]\nPass rate dipped after deploy d-2026-07-01-042 [3].',
    );

    // Concatenated in step order, NOT deduplicated.
    expect(result.answer!.citations.map((c) => c.doc_id)).toEqual([
      'cloud/cost-report',
      'cloud/inventory-snapshot',
      'code/ci-activity',
    ]);
    // MIN confidence over completed steps.
    expect(result.answer!.confidence).toBe(0.8);
  });

  it('falls back to a capability-only attribution line when the agent is unknown', () => {
    const result = synthesizeAnswer(outcomes.map(({ agent: _agent, ...rest }) => rest));
    expect(result.answer!.text.startsWith('[cloud.cost_analysis]\n')).toBe(true);
  });

  it('does not deduplicate repeated citations', () => {
    const result = synthesizeAnswer([
      outcomes[0]!,
      {
        ...outcomes[1]!,
        result: completedResult(1, costAnswer as unknown as Record<string, unknown>),
      },
    ]);
    expect(result.answer!.citations).toHaveLength(4);
  });
});

describe('status matrix and gap formats', () => {
  const okStep: StepOutcome = {
    planStep: planStep(0, 'cloud.cost_analysis'),
    result: completedResult(0, costAnswer as unknown as Record<string, unknown>),
  };

  it('some completed + some failed → partial with a survivor answer and mandatory gaps', () => {
    const result = synthesizeAnswer([
      okStep,
      {
        planStep: planStep(1, 'code.ci_health'),
        agent: { agentId: 'code-agent', agentVersion: '0.1.0' },
        result: failedResult(1, { class: 'needs_input', message: 'repo is required' }),
      },
    ]);
    expect(result.status).toBe('partial');
    expect(result.answer!.text).toContain('30.0');
    expect(result.gaps).toEqual(['code.ci_health (code-agent): repo is required']);
    // Non-budget partials carry the story in gaps, not error.
    expect(result.error).toBeUndefined();
  });

  it('some completed + some skipped → partial with the recorded skip gap verbatim', () => {
    const result = synthesizeAnswer([
      okStep,
      {
        planStep: planStep(1, 'code.ci_health'),
        skipReason: 'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
      },
    ]);
    expect(result.status).toBe('partial');
    expect(result.gaps).toEqual([
      'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
    ]);
  });

  it('none completed → failed with the FIRST failed step error in plan order + gaps for the rest', () => {
    const result = synthesizeAnswer([
      {
        planStep: planStep(0, 'cloud.cost_analysis'),
        result: failedResult(0, { class: 'retryable', message: 'mock unavailable' }),
      },
      {
        planStep: planStep(1, 'code.ci_health'),
        skipReason: 'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
      },
    ]);
    expect(result.status).toBe('failed');
    expect(result.answer).toBeUndefined();
    expect(result.error).toEqual({ class: 'retryable', message: 'mock unavailable' });
    expect(result.gaps).toEqual([
      'cloud.cost_analysis: mock unavailable',
      'code.ci_health: skipped — depends on cloud.cost_analysis, which failed',
    ]);
  });

  it('budget-exhausted shape: survivors + a not-executed gap per unstarted step', () => {
    const result = synthesizeAnswer([
      okStep,
      {
        planStep: planStep(1, 'code.ci_health'),
        skipReason:
          'budget exhausted after step 1 of 2: max_steps 1 reached — code.ci_health not executed',
      },
    ]);
    expect(result.status).toBe('partial');
    expect(result.gaps[0]).toContain('max_steps 1 reached');
    expect(result.gaps[0]).toContain('code.ci_health not executed');
  });
});
