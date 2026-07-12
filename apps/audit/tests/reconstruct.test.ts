import type { AuditEvent } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import type { ChainRow } from '../src/chain.js';
import { reconstructTask } from '../src/reconstruct.js';

const TASK = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
const STEP_A = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f01';
const STEP_B = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f02';

/** Wraps events as chain rows in the given chain_seq order (assembly reads that order). */
function rowsOf(events: AuditEvent[], startSeq = 10): ChainRow[] {
  return events.map((event, i) => ({
    chain_seq: startSeq + i,
    prev_hash: `sha256:${'0'.repeat(64)}`,
    record_hash: `sha256:${'0'.repeat(64)}`,
    event,
  }));
}

function ev(over: Partial<AuditEvent>): AuditEvent {
  return {
    event_id: over.event_id ?? '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f99',
    occurred_at: over.occurred_at ?? '2026-07-11T09:00:00Z',
    tenant: 'acme',
    event_type: over.event_type ?? 'tool.called',
    actor: over.actor ?? { principal: 'svc:orchestrator' },
    action: over.action ?? { name: 'x' },
    ...(over.reason === undefined ? {} : { reason: over.reason }),
    ...(over.artifacts === undefined ? {} : { artifacts: over.artifacts }),
    ...(over.details === undefined ? {} : { details: over.details }),
  };
}

describe('reconstructTask (scenario-4-shaped set)', () => {
  const events: AuditEvent[] = [
    ev({
      event_type: 'task.submitted',
      actor: { principal: 'user:jane' },
      reason: { task_id: TASK },
      action: { name: 't', inputs_digest: `sha256:${'a'.repeat(64)}` },
      artifacts: { workflow_run_id: 'run-1' },
    }),
    ev({
      event_type: 'task.planned',
      action: { name: 't', outputs_digest: `sha256:${'b'.repeat(64)}` },
      reason: { task_id: TASK },
      details: { planner: 'rule-planner@1', plan: { steps: [] } },
    }),
    ev({
      event_type: 'step.dispatched',
      reason: { task_id: TASK, step_id: STEP_A },
      artifacts: { agent_id: 'change-agent', agent_version: '0.1.0' },
      details: {
        capability: 'change.submit',
        route: 'active',
        policy: { decision: 'require-approval', bundle_version: '2026.07' },
      },
    }),
    ev({
      event_type: 'approval.requested',
      reason: { task_id: TASK, step_id: STEP_A },
      details: { approval_id: 'ap-1' },
    }),
    ev({
      event_type: 'approval.granted',
      actor: { principal: 'user:boss' },
      reason: { task_id: TASK, step_id: STEP_A },
      details: { approval_id: 'ap-1', latency_ms: 4200, rubber_stamp: false },
    }),
    ev({
      event_type: 'token.brokered',
      reason: { task_id: TASK, step_id: STEP_A },
      details: { audience: 'acp:agent:change-agent', scope: 'itsm:write' },
    }),
    ev({
      event_type: 'tool.called',
      reason: { task_id: TASK, step_id: STEP_A },
      details: { server: 'itsm', tool: 'change_submit', outcome: 'ok' },
    }),
    ev({
      event_type: 'step.completed',
      reason: { task_id: TASK, step_id: STEP_A },
      details: { status: 'completed', usage: { input_tokens: 10 } },
    }),
    ev({
      event_type: 'step.skipped',
      reason: { task_id: TASK, step_id: STEP_B },
      details: { capability: 'change.verify', gap: 'depends on change.submit, which failed' },
    }),
    ev({
      event_type: 'compensation.completed',
      reason: { task_id: TASK },
      details: { status: 'complete', compensated: [{ compensator: 'change.withdraw' }] },
    }),
    ev({
      event_type: 'task.completed',
      reason: { task_id: TASK },
      details: {
        status: 'partial',
        gaps: ['change.verify skipped'],
        compensation: { status: 'complete' },
      },
    }),
  ];

  const recon = reconstructTask(TASK, 'acme', rowsOf(events), false);

  it('reports integrity span and record count', () => {
    expect(recon.integrity.records).toBe(events.length);
    expect(recon.integrity.span).toEqual({ from_seq: 10, to_seq: 10 + events.length - 1 });
  });

  it('assembles submission, plan, and terminal outcome', () => {
    expect(recon.submitted).toMatchObject({ actor: 'user:jane', workflow_run_id: 'run-1' });
    expect(recon.plan).toMatchObject({ planner: 'rule-planner@1' });
    expect(recon.outcome).toMatchObject({ status: 'partial' });
  });

  it('groups events by step in first-seen order, with delegation + approval + tools', () => {
    expect(recon.steps.map((s) => s.step_id)).toEqual([STEP_A, STEP_B]);
    const a = recon.steps[0]!;
    expect(a.capability).toBe('change.submit');
    expect(a.agent).toEqual({ id: 'change-agent', version: '0.1.0' });
    expect(a.policy_decisions).toHaveLength(1);
    expect(a.approval).toMatchObject({
      status: 'granted',
      approver: 'user:boss',
      latency_ms: 4200,
    });
    expect(a.tokens).toHaveLength(1);
    expect(a.tool_calls[0]).toMatchObject({ server: 'itsm', tool: 'change_submit', outcome: 'ok' });
    expect(a.completed).toMatchObject({ status: 'completed' });
    expect(recon.steps[1]?.skipped?.gap).toContain('depends on');
  });

  it('surfaces the compensation summary from compensation.completed', () => {
    expect(recon.compensation).toMatchObject({ status: 'complete' });
  });

  it('produces a chain_seq-ordered timeline with step attribution', () => {
    expect(recon.timeline).toHaveLength(events.length);
    expect(recon.timeline[0]).toMatchObject({ event_type: 'task.submitted', chain_seq: 10 });
    expect(recon.timeline.at(-1)).toMatchObject({ event_type: 'task.completed' });
    expect(recon.timeline[2]).toMatchObject({ event_type: 'step.dispatched', step_id: STEP_A });
  });

  it('flags cancellation when a task.cancel_requested is present', () => {
    const cancelled = reconstructTask(
      TASK,
      'acme',
      rowsOf([
        ev({
          event_type: 'task.cancel_requested',
          actor: { principal: 'svc:gateway' },
          reason: { task_id: TASK },
          details: { trigger: 'fleet_killswitch', reason: 'p1' },
        }),
      ]),
      false,
    );
    expect(cancelled.cancellation).toMatchObject({
      trigger: 'fleet_killswitch',
      actor: 'svc:gateway',
    });
  });

  it('carries the truncated flag through', () => {
    expect(reconstructTask(TASK, 'acme', rowsOf(events), true).truncated).toBe(true);
  });

  it('handles an empty record set (null span, no sections)', () => {
    const empty = reconstructTask(TASK, 'acme', [], false);
    expect(empty.integrity).toEqual({ records: 0, span: null });
    expect(empty.steps).toEqual([]);
    expect(empty.timeline).toEqual([]);
    expect(empty.submitted).toBeUndefined();
  });

  it('assembles sparse events (missing optional fields) without crashing', () => {
    const sparse = reconstructTask(
      TASK,
      'acme',
      rowsOf([
        ev({
          event_type: 'task.submitted',
          actor: { principal: 'user:x' },
          reason: { task_id: TASK },
          action: { name: 't' },
        }),
        ev({ event_type: 'task.planned', reason: { task_id: TASK }, action: { name: 't' } }),
        // dispatched with no agent/route/policy details, and NO step_id (task-level).
        ev({ event_type: 'step.dispatched', reason: { task_id: TASK }, details: {} }),
        // a fully-detailed dispatched carrying a step but no policy.
        ev({
          event_type: 'step.dispatched',
          reason: { task_id: TASK, step_id: STEP_A },
          details: { capability: 'x.y' },
        }),
        // an approval.denied names its approver; a token with no audience/scope.
        ev({
          event_type: 'approval.denied',
          actor: { principal: 'user:boss' },
          reason: { task_id: TASK, step_id: STEP_A },
          details: {},
        }),
        ev({
          event_type: 'token.brokered',
          reason: { task_id: TASK, step_id: STEP_A },
          details: {},
        }),
        // a tool refusal carries the refusal marker.
        ev({
          event_type: 'tool.called',
          reason: { task_id: TASK, step_id: STEP_A },
          details: {
            server: 's',
            tool: 't',
            outcome: 'error:upstream_auth',
            refusal: 'killswitch',
          },
        }),
        // compensation.started before completed → in_progress summary.
        ev({
          event_type: 'compensation.started',
          reason: { task_id: TASK },
          details: { stack_depth: 1 },
        }),
        // an unmodelled event type is ignored except for the timeline.
        ev({
          event_type: 'model.invoked',
          reason: { task_id: TASK, step_id: STEP_A },
          details: {},
        }),
        ev({
          event_type: 'task.completed',
          reason: { task_id: TASK },
          details: { status: 'failed' },
        }),
      ]),
      false,
    );
    expect(sparse.submitted).toMatchObject({ actor: 'user:x' });
    expect(typeof sparse.plan?.at).toBe('string');
    const a = sparse.steps.find((s) => s.step_id === STEP_A);
    expect(a).toBeDefined();
    expect(a!.approval).toMatchObject({ status: 'denied', approver: 'user:boss' });
    expect(Object.keys(a!.tokens[0] ?? {})).toEqual(['at']);
    expect(a!.tool_calls[0]).toMatchObject({ refusal: 'killswitch' });
    expect(sparse.compensation).toMatchObject({ in_progress: { stack_depth: 1 } });
    // A dispatched with no step_id did not create a phantom step.
    expect(sparse.steps.map((s) => s.step_id)).toEqual([STEP_A]);
    // The unmodelled model.invoked still appears in the timeline.
    expect(sparse.timeline.some((t) => t.event_type === 'model.invoked')).toBe(true);
  });
});
