/**
 * Task reconstruction (item 5, D10) — FORENSIC ASSEMBLY, not re-execution. Given
 * the ordered audit records for a task (in chain_seq order — the total order the
 * hash chain bought), assemble a service-local read-model narrating what
 * happened: submission, plan, each step's dispatch/policy/approval/tokens/tool
 * calls/outcome, the compensation unwind, and the terminal result. Every
 * versioned artifact is already in the events (plan digest, bundle version +
 * determining policies, agent versions, lineage ids, approver) — this is a join,
 * not an investigation. Re-execution lives in the deployment shadow / eval paths;
 * both read the same stream (governance "one implementation").
 */

import type { ChainRow } from './chain.js';

interface StepReconstruction {
  step_id: string;
  capability?: string;
  agent?: { id?: string | undefined; version?: string | undefined };
  route?: unknown;
  dispatched_at?: string;
  policy_decisions: unknown[];
  approval?: {
    status: 'requested' | 'granted' | 'denied' | 'timeout';
    approval_id?: string;
    approver?: string;
    latency_ms?: number;
    rubber_stamp?: boolean;
  };
  tokens: { at: string; audience?: unknown; scope?: unknown }[];
  tool_calls: { at: string; server?: unknown; tool?: unknown; outcome?: unknown; refusal?: unknown }[];
  completed?: { at: string; status: unknown; usage?: unknown };
  skipped?: { at: string; gap?: unknown };
  compensation?: unknown;
}

export interface TaskReconstruction {
  task_id: string;
  tenant: string;
  truncated: boolean;
  integrity: {
    records: number;
    span: { from_seq: number; to_seq: number } | null;
  };
  submitted?: { at: string; actor: string; inputs_digest?: unknown; workflow_run_id?: unknown };
  plan?: { at: string; planner?: unknown; plan_digest?: unknown; plan?: unknown };
  steps: StepReconstruction[];
  compensation?: unknown;
  cancellation?: { at: string; actor: string; trigger?: unknown; reason?: unknown };
  outcome?: { at: string; status: unknown; gaps?: unknown };
  timeline: { chain_seq: number; event_type: string; occurred_at: string; step_id?: string }[];
}

/** Assembles the read-model from a task's ordered chain rows (chain_seq ascending). */
export function reconstructTask(
  taskId: string,
  tenant: string,
  rows: ChainRow[],
  truncated: boolean,
): TaskReconstruction {
  const steps = new Map<string, StepReconstruction>();
  const stepOrder: string[] = [];
  const stepOf = (stepId: string): StepReconstruction => {
    let s = steps.get(stepId);
    if (s === undefined) {
      s = { step_id: stepId, policy_decisions: [], tokens: [], tool_calls: [] };
      steps.set(stepId, s);
      stepOrder.push(stepId);
    }
    return s;
  };

  const recon: TaskReconstruction = {
    task_id: taskId,
    tenant,
    truncated,
    integrity: {
      records: rows.length,
      span:
        rows.length === 0
          ? null
          : { from_seq: rows[0]!.chain_seq, to_seq: rows[rows.length - 1]!.chain_seq },
    },
    steps: [],
    timeline: [],
  };

  for (const row of rows) {
    const e = row.event;
    const stepId = e.reason?.step_id;
    const details = (e.details ?? {}) as Record<string, unknown>;
    recon.timeline.push({
      chain_seq: row.chain_seq,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      ...(stepId === undefined ? {} : { step_id: stepId }),
    });

    switch (e.event_type) {
      case 'task.submitted':
        recon.submitted = {
          at: e.occurred_at,
          actor: e.actor.principal,
          ...(e.action.inputs_digest === undefined ? {} : { inputs_digest: e.action.inputs_digest }),
          ...(e.artifacts?.workflow_run_id === undefined
            ? {}
            : { workflow_run_id: e.artifacts.workflow_run_id }),
        };
        break;
      case 'task.planned':
        recon.plan = {
          at: e.occurred_at,
          ...(details.planner === undefined ? {} : { planner: details.planner }),
          ...(e.action.outputs_digest === undefined ? {} : { plan_digest: e.action.outputs_digest }),
          ...(details.plan === undefined ? {} : { plan: details.plan }),
        };
        break;
      case 'step.dispatched':
        if (stepId !== undefined) {
          const s = stepOf(stepId);
          s.dispatched_at = e.occurred_at;
          if (details.capability !== undefined) s.capability = String(details.capability);
          if (e.artifacts?.agent_id !== undefined || e.artifacts?.agent_version !== undefined) {
            s.agent = { id: e.artifacts?.agent_id, version: e.artifacts?.agent_version };
          }
          if (details.route !== undefined) s.route = details.route;
          if (details.policy !== undefined) s.policy_decisions.push(details.policy);
        }
        break;
      case 'step.completed':
        if (stepId !== undefined) {
          stepOf(stepId).completed = {
            at: e.occurred_at,
            status: details.status,
            ...(details.usage === undefined ? {} : { usage: details.usage }),
          };
        }
        break;
      case 'step.skipped':
        if (stepId !== undefined) {
          stepOf(stepId).skipped = { at: e.occurred_at, gap: details.gap };
        }
        break;
      case 'approval.requested':
      case 'approval.granted':
      case 'approval.denied':
      case 'approval.timeout':
        if (stepId !== undefined) {
          const status = e.event_type.slice('approval.'.length) as
            | 'requested'
            | 'granted'
            | 'denied'
            | 'timeout';
          stepOf(stepId).approval = {
            status,
            ...(details.approval_id === undefined ? {} : { approval_id: String(details.approval_id) }),
            ...(e.event_type === 'approval.granted' || e.event_type === 'approval.denied'
              ? { approver: e.actor.principal }
              : {}),
            ...(details.latency_ms === undefined ? {} : { latency_ms: Number(details.latency_ms) }),
            ...(details.rubber_stamp === undefined ? {} : { rubber_stamp: Boolean(details.rubber_stamp) }),
          };
        }
        break;
      case 'token.brokered':
        if (stepId !== undefined) {
          stepOf(stepId).tokens.push({
            at: e.occurred_at,
            ...(details.audience === undefined ? {} : { audience: details.audience }),
            ...(details.scope === undefined ? {} : { scope: details.scope }),
          });
        }
        break;
      case 'tool.called':
        if (stepId !== undefined) {
          stepOf(stepId).tool_calls.push({
            at: e.occurred_at,
            server: details.server,
            tool: details.tool,
            outcome: details.outcome,
            ...(details.refusal === undefined ? {} : { refusal: details.refusal }),
          });
        }
        break;
      case 'compensation.started':
      case 'compensation.step_failed':
      case 'compensation.completed':
        // The completed record is the authoritative compensation summary.
        if (e.event_type === 'compensation.completed') recon.compensation = details;
        else if (recon.compensation === undefined) recon.compensation = { in_progress: details };
        break;
      case 'task.cancel_requested':
        recon.cancellation = {
          at: e.occurred_at,
          actor: e.actor.principal,
          ...(details.trigger === undefined ? {} : { trigger: details.trigger }),
          ...(details.reason === undefined ? {} : { reason: details.reason }),
        };
        break;
      case 'task.completed':
        recon.outcome = {
          at: e.occurred_at,
          status: details.status,
          ...(details.gaps === undefined ? {} : { gaps: details.gaps }),
        };
        if (details.compensation !== undefined) recon.compensation = details.compensation;
        break;
      default:
        break;
    }
  }

  recon.steps = stepOrder.map((id) => steps.get(id)!);
  return recon;
}
