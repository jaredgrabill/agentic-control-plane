import type { AuditEvent } from '@acp/protocol';
import type { ResolvedPriceBook } from '@acp/cost-meter/pricing';
import { describe, expect, it } from 'vitest';
import { GateEvaluator, type GateThresholds } from '../src/deployment-gates.js';

const THRESHOLDS: GateThresholds = {
  max_success_delta: 0.05,
  max_p95_ratio: 1.5,
  max_cost_ratio: 1.25,
  min_shadow_completion: 0.9,
  min_shadow_samples: 2,
  max_quality_delta: 0.1,
  min_quality_samples: 2,
};

let seq = 0;
function uuid(): string {
  seq += 1;
  return `0197a3b0-6c1e-7d3a-8f4b-${seq.toString(16).padStart(12, '0')}`;
}

function stepCompleted(over: {
  version: string;
  status?: string;
  durationMs?: number;
  taskId?: string;
  stepId?: string;
  usage?: Record<string, number>;
}): AuditEvent {
  return {
    event_id: uuid(),
    occurred_at: '2026-07-11T10:00:00Z',
    tenant: 'acme',
    event_type: 'step.completed',
    actor: { principal: 'svc:orchestrator' },
    action: { name: 'step.completed' },
    reason: { task_id: over.taskId ?? uuid(), step_id: over.stepId ?? uuid() },
    artifacts: { agent_id: 'knowledge-agent', agent_version: over.version },
    details: {
      status: over.status ?? 'completed',
      ...(over.durationMs === undefined ? {} : { duration_ms: over.durationMs }),
      ...(over.usage === undefined ? {} : { usage: over.usage }),
    },
  };
}

function shadowResult(over: {
  status?: string;
  durationMs?: number;
  taskId: string;
  stepId: string;
  usage?: Record<string, number>;
}): AuditEvent {
  return {
    event_id: uuid(),
    occurred_at: '2026-07-11T10:00:01Z',
    tenant: 'acme',
    event_type: 'deployment.shadow_result',
    actor: { principal: 'svc:orchestrator' },
    action: { name: 'deployment.shadow_result' },
    reason: { task_id: over.taskId, step_id: over.stepId },
    artifacts: { agent_id: 'knowledge-agent', agent_version: '0.2.0' },
    details: {
      status: over.status ?? 'completed',
      incumbent_version: '0.1.0',
      ...(over.durationMs === undefined ? {} : { duration_ms: over.durationMs }),
      ...(over.usage === undefined ? {} : { usage: over.usage }),
    },
  };
}

const evaluator = new GateEvaluator();

describe('canary gate', () => {
  it('passes when candidate success/latency match the incumbent', () => {
    const events = [
      ...Array.from({ length: 5 }, () => stepCompleted({ version: '0.2.0', durationMs: 200 })),
      ...Array.from({ length: 20 }, () => stepCompleted({ version: '0.1.0', durationMs: 210 })),
    ];
    const report = evaluator.evaluateCanary(events, {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
    });
    expect(report.verdict).toBe('pass');
    expect(report.samples).toEqual({ candidate: 5, incumbent: 20 });
    expect(report.metrics.success_ratio).toBe(1);
  });

  it('fails on a success-ratio breach', () => {
    const events = [
      // 3/5 candidate completed = 0.6, incumbent 1.0 → delta 0.4 > 0.05.
      ...Array.from({ length: 3 }, () => stepCompleted({ version: '0.2.0' })),
      ...Array.from({ length: 2 }, () => stepCompleted({ version: '0.2.0', status: 'failed' })),
      ...Array.from({ length: 10 }, () => stepCompleted({ version: '0.1.0' })),
    ];
    const report = evaluator.evaluateCanary(events, {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
    });
    expect(report.verdict).toBe('fail');
    expect(report.reasons.join(' ')).toContain('success ratio');
  });

  it('fails on a p95 latency breach', () => {
    const events = [
      ...Array.from({ length: 5 }, () => stepCompleted({ version: '0.2.0', durationMs: 1000 })),
      ...Array.from({ length: 10 }, () => stepCompleted({ version: '0.1.0', durationMs: 200 })),
    ];
    const report = evaluator.evaluateCanary(events, {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
    });
    expect(report.verdict).toBe('fail');
    expect(report.reasons.join(' ')).toContain('p95 latency');
  });

  it('fails on a cost breach when both versions are priced', () => {
    const book: ResolvedPriceBook = {
      version: 'test',
      models: {},
      fallback: {
        inputMicrosPerMTok: 1_000_000,
        outputMicrosPerMTok: 1_000_000,
        cacheReadMicrosPerMTok: 0,
        cacheWriteMicrosPerMTok: 0,
      },
    };
    const events = [
      ...Array.from({ length: 5 }, () =>
        stepCompleted({
          version: '0.2.0',
          usage: { input_tokens: 10000, output_tokens: 0, llm_calls: 1 },
        }),
      ),
      ...Array.from({ length: 10 }, () =>
        stepCompleted({
          version: '0.1.0',
          usage: { input_tokens: 1000, output_tokens: 0, llm_calls: 1 },
        }),
      ),
    ];
    const report = evaluator.evaluateCanary(events, {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
      priceBook: book,
    });
    expect(report.verdict).toBe('fail');
    expect(report.reasons.join(' ')).toContain('cost/step');
  });

  it('is insufficient_data with no candidate samples (a gate that cannot measure does not pass)', () => {
    const report = evaluator.evaluateCanary([stepCompleted({ version: '0.1.0' })], {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
    });
    expect(report.verdict).toBe('insufficient_data');
    expect(report.samples.candidate).toBe(0);
  });
});

describe('shadow gate', () => {
  it('joins shadow results to primaries and passes when comparable', () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 4; i += 1) {
      const taskId = uuid();
      const stepId = uuid();
      events.push(stepCompleted({ version: '0.1.0', taskId, stepId, durationMs: 200 }));
      events.push(shadowResult({ taskId, stepId, durationMs: 210 }));
    }
    const report = evaluator.evaluateShadow(events, { thresholds: THRESHOLDS });
    expect(report.verdict).toBe('pass');
    expect(report.samples.candidate).toBe(4);
    expect(report.metrics.success_ratio).toBe(1);
  });

  it('is insufficient_data below the sample floor', () => {
    const taskId = uuid();
    const stepId = uuid();
    const report = evaluator.evaluateShadow(
      [stepCompleted({ version: '0.1.0', taskId, stepId }), shadowResult({ taskId, stepId })],
      { thresholds: { ...THRESHOLDS, min_shadow_samples: 5 } },
    );
    expect(report.verdict).toBe('insufficient_data');
  });

  it('fails when shadow completion falls below the floor', () => {
    const events: AuditEvent[] = [];
    // 2/4 shadow completed = 0.5 < 0.9.
    for (let i = 0; i < 4; i += 1) {
      const taskId = uuid();
      const stepId = uuid();
      events.push(stepCompleted({ version: '0.1.0', taskId, stepId }));
      events.push(shadowResult({ taskId, stepId, status: i < 2 ? 'completed' : 'failed' }));
    }
    const report = evaluator.evaluateShadow(events, { thresholds: THRESHOLDS });
    expect(report.verdict).toBe('fail');
    expect(report.reasons.join(' ')).toContain('shadow completion');
  });

  it('ignores unpaired shadow results (no matching primary)', () => {
    // A shadow result whose primary step is absent cannot be compared → dropped.
    const report = evaluator.evaluateShadow([shadowResult({ taskId: uuid(), stepId: uuid() })], {
      thresholds: THRESHOLDS,
    });
    expect(report.samples.candidate).toBe(0);
    expect(report.verdict).toBe('insufficient_data');
  });
});

describe('judged quality fold (item 6)', () => {
  const evaluator = new GateEvaluator();
  const pairedShadow = () => {
    const a = { taskId: uuid(), stepId: uuid() };
    const b = { taskId: uuid(), stepId: uuid() };
    return [
      stepCompleted({ version: '0.1.0', ...a }),
      stepCompleted({ version: '0.1.0', ...b }),
      shadowResult(a),
      shadowResult(b),
    ];
  };

  it('fills metrics.quality and passes when the candidate is within delta', () => {
    const report = evaluator.evaluateCanary(
      Array.from({ length: 5 }, () => stepCompleted({ version: '0.2.0' })).concat(
        Array.from({ length: 10 }, () => stepCompleted({ version: '0.1.0' })),
      ),
      {
        candidateVersion: '0.2.0',
        incumbentVersion: '0.1.0',
        thresholds: THRESHOLDS,
        quality: { candidateMean: 0.9, incumbentMean: 0.92, candidateN: 5, incumbentN: 20 },
      },
    );
    expect(report.metrics.quality).toBe(0.9);
    expect(report.verdict).toBe('pass');
  });

  it('breaches when candidate quality falls more than max_quality_delta below the incumbent', () => {
    const report = evaluator.evaluateCanary(
      Array.from({ length: 5 }, () => stepCompleted({ version: '0.2.0' })).concat(
        Array.from({ length: 10 }, () => stepCompleted({ version: '0.1.0' })),
      ),
      {
        candidateVersion: '0.2.0',
        incumbentVersion: '0.1.0',
        thresholds: THRESHOLDS,
        quality: { candidateMean: 0.7, incumbentMean: 0.92, candidateN: 5, incumbentN: 20 },
      },
    );
    expect(report.verdict).toBe('fail');
    expect(report.reasons.join(' ')).toContain('judged quality');
  });

  it('omits quality when either side has too few samples', () => {
    const report = evaluator.evaluateCanary([stepCompleted({ version: '0.2.0' })], {
      candidateVersion: '0.2.0',
      incumbentVersion: '0.1.0',
      thresholds: THRESHOLDS,
      quality: { candidateMean: 0.5, incumbentMean: 0.95, candidateN: 1, incumbentN: 20 },
    });
    expect(report.metrics.quality).toBeUndefined();
  });

  it('omits quality when a mean is null (uncalibrated / no scores)', () => {
    const report = evaluator.evaluateShadow(pairedShadow(), {
      thresholds: THRESHOLDS,
      quality: { candidateMean: null, incumbentMean: 0.9, candidateN: 5, incumbentN: 5 },
    });
    expect(report.metrics.quality).toBeUndefined();
  });

  it('folds shadow-route quality into the shadow gate', () => {
    const report = evaluator.evaluateShadow(pairedShadow(), {
      thresholds: THRESHOLDS,
      quality: { candidateMean: 0.6, incumbentMean: 0.95, candidateN: 5, incumbentN: 5 },
    });
    expect(report.metrics.quality).toBe(0.6);
    expect(report.reasons.join(' ')).toContain('judged quality');
  });
});
