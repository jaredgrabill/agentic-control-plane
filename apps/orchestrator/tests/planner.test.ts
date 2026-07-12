import type { TaskRequest } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITY, RULE_PLANNER, buildPlanSteps } from '../src/planner.js';

const FULL_FLEET = new Set([
  'knowledge.answer_with_citations',
  'cloud.inventory_query',
  'cloud.cost_analysis',
  'code.dependency_query',
  'code.ci_health',
]);

function task(input: TaskRequest['input']): TaskRequest {
  return {
    kind: 'task_request',
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    principal: 'user:jane.doe',
    input,
  };
}

const FORENSICS_TEXT = 'Why did cloud spend jump last week?';

describe('rule 1: explicit capability route', () => {
  it('maps the default capability to a question — the v0 byte-for-byte mapping', () => {
    const steps = buildPlanSteps(
      task({ text: 'What is the freeze policy?', capability: DEFAULT_CAPABILITY }),
      FULL_FLEET,
    );
    expect(steps).toEqual([
      { capability: DEFAULT_CAPABILITY, input: { question: 'What is the freeze policy?' } },
    ]);
  });

  it('passes context through for other capabilities, falling back to {text}', () => {
    const withContext = buildPlanSteps(
      task({ text: 'inventory', capability: 'cloud.inventory_query', context: { env: 'prod' } }),
      FULL_FLEET,
    );
    expect(withContext).toEqual([{ capability: 'cloud.inventory_query', input: { env: 'prod' } }]);

    const withoutContext = buildPlanSteps(
      task({ text: 'inventory', capability: 'cloud.inventory_query' }),
      FULL_FLEET,
    );
    expect(withoutContext).toEqual([
      { capability: 'cloud.inventory_query', input: { text: 'inventory' } },
    ]);
  });

  it('wins over the forensics composite: an explicit route is one step, always', () => {
    const steps = buildPlanSteps(
      task({ text: FORENSICS_TEXT, capability: 'cloud.cost_analysis', context: {} }),
      FULL_FLEET,
    );
    expect(steps).toEqual([{ capability: 'cloud.cost_analysis', input: {} }]);
  });
});

describe('rule 2: cost-spike forensics composite', () => {
  it('fans out to cost analysis + CI health when a repo is in context — independent steps', () => {
    const steps = buildPlanSteps(
      task({ text: FORENSICS_TEXT, context: { repo: 'acme/payments-service' } }),
      FULL_FLEET,
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      capability: 'cloud.cost_analysis',
      input: {},
      rationale: 'attribute the spend change to a service and deploy',
    });
    expect(steps[1]).toEqual({
      capability: 'code.ci_health',
      input: { repo: 'acme/payments-service' },
      rationale: 'correlate CI/deploy activity for the implicated repo',
    });
    // Parallel fan-out: neither step depends on the other.
    expect(steps.some((s) => s.dependsOnIndex !== undefined)).toBe(false);
  });

  it('plans cost analysis alone without a repo — no default repo is ever invented', () => {
    for (const context of [undefined, {}, { repo: 42 }]) {
      const steps = buildPlanSteps(
        task({ text: FORENSICS_TEXT, ...(context === undefined ? {} : { context }) }),
        FULL_FLEET,
      );
      expect(steps.map((s) => s.capability)).toEqual(['cloud.cost_analysis']);
    }
  });

  it('requires BOTH keyword groups', () => {
    // Spend words without anomaly words.
    expect(
      buildPlanSteps(task({ text: 'what is our cloud spend' }), FULL_FLEET)[0]!.capability,
    ).toBe(DEFAULT_CAPABILITY);
    // Anomaly words without spend words.
    expect(buildPlanSteps(task({ text: 'why did latency spike' }), FULL_FLEET)[0]!.capability).toBe(
      DEFAULT_CAPABILITY,
    );
    // Both groups, case-insensitive.
    expect(buildPlanSteps(task({ text: 'COSTS ROSE sharply' }), FULL_FLEET)[0]!.capability).toBe(
      'cloud.cost_analysis',
    );
  });

  it('never plans unservable steps: no cost agent → default; no CI agent → cost only', () => {
    const noCloud = new Set([...FULL_FLEET].filter((c) => c !== 'cloud.cost_analysis'));
    expect(
      buildPlanSteps(task({ text: FORENSICS_TEXT, context: { repo: 'a/b' } }), noCloud).map(
        (s) => s.capability,
      ),
    ).toEqual([DEFAULT_CAPABILITY]);

    const noCi = new Set([...FULL_FLEET].filter((c) => c !== 'code.ci_health'));
    expect(
      buildPlanSteps(task({ text: FORENSICS_TEXT, context: { repo: 'a/b' } }), noCi).map(
        (s) => s.capability,
      ),
    ).toEqual(['cloud.cost_analysis']);
  });
});

describe('rule 3: default', () => {
  it('routes unmatched questions to the knowledge agent with the v0 question mapping', () => {
    const steps = buildPlanSteps(task({ text: 'What does the freeze policy say?' }), FULL_FLEET);
    expect(steps).toEqual([
      { capability: DEFAULT_CAPABILITY, input: { question: 'What does the freeze policy say?' } },
    ]);
  });

  it('is total: plans the default step even when nothing can serve it', () => {
    const steps = buildPlanSteps(task({ text: 'anything at all' }), new Set());
    expect(steps).toEqual([
      { capability: DEFAULT_CAPABILITY, input: { question: 'anything at all' } },
    ]);
  });
});

describe('determinism', () => {
  it('identical inputs produce identical plans', () => {
    const t = task({ text: FORENSICS_TEXT, context: { repo: 'acme/payments-service' } });
    expect(buildPlanSteps(t, FULL_FLEET)).toEqual(buildPlanSteps(t, FULL_FLEET));
    expect(RULE_PLANNER).toBe('rule-planner@1');
  });
});
