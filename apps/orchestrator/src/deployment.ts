/**
 * DeploymentWorkflow (D7) — the Deployment Controller. Drives a candidate agent
 * version through shadow → canary ramp → owner approval (R2+) → atomic promote →
 * drain, gating each phase on the deterministic GateEvaluator and auto-rolling
 * back or demoting on a breach. Deterministic isolate code: every effect (a
 * registry transition, a gate evaluation, an audit emission) is an activity.
 *
 * Rollback policy: a canary gate breach rolls the ramp back one step; a breach
 * at the first step, or two consecutive breaches, demotes the candidate to
 * shadow (deployment.demoted + deployment.failed). An abort signal mid-canary
 * demotes to shadow. Final promotion of an R2/R3-capable candidate reuses the
 * item-1 ApprovalWorkflow (owner approval).
 */

import {
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  sleep,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import {
  APPROVAL_DENY_AFTER_S,
  APPROVAL_ESCALATE_AFTER_S,
  type ApprovalGateInput,
  type ApprovalOutcome,
  type ApprovalSubject,
  type ControlActivities,
  type DeploymentRequest,
  type GateReport,
} from './types.js';
import { ApprovalWorkflow } from './workflows.js';

const control = proxyActivities<ControlActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

/** An operator or the owner aborts a running deployment; it demotes to shadow. */
export const abortDeploymentSignal = defineSignal('abortDeployment');

export interface DeploymentStatus {
  deployment_id: string;
  phase: 'preflight' | 'shadow' | 'canary' | 'approval' | 'promote' | 'drain' | 'terminal';
  ramp_percent?: number;
  aborted: boolean;
  gate_reports: GateReport[];
}
export const deploymentStatusQuery = defineQuery<DeploymentStatus>('deploymentStatus');

export interface DeploymentResult {
  deployment_id: string;
  status: 'completed' | 'failed' | 'demoted';
  candidate_version: string;
  incumbent_version?: string;
  reason: string;
  gate_reports: GateReport[];
  approval_id?: string;
}

export async function DeploymentWorkflow(req: DeploymentRequest): Promise<DeploymentResult> {
  const { agent_id, candidate_version, deployment_id, tenant, config } = req;
  let aborted = false;
  let phase: DeploymentStatus['phase'] = 'preflight';
  let rampPercent: number | undefined;
  const gateReports: GateReport[] = [];

  setHandler(abortDeploymentSignal, () => {
    aborted = true;
  });
  // Read through a function so flow analysis does not narrow the signal-mutated
  // flag to a constant (mirrors TaskWorkflow's isCancelled()).
  const isAborted = (): boolean => aborted;
  setHandler(deploymentStatusQuery, (): DeploymentStatus => ({
    deployment_id,
    phase,
    ...(rampPercent === undefined ? {} : { ramp_percent: rampPercent }),
    aborted,
    gate_reports: gateReports,
  }));

  const emit = (type: string, details: Record<string, unknown>): Promise<void> =>
    control.emitAudit(deploymentAudit(req, candidate_version, type, details));

  const result = (
    status: DeploymentResult['status'],
    reason: string,
    incumbent?: string,
    approvalId?: string,
  ): DeploymentResult => ({
    deployment_id,
    status,
    candidate_version,
    ...(incumbent === undefined ? {} : { incumbent_version: incumbent }),
    reason,
    gate_reports: gateReports,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
  });

  // --- Preflight -------------------------------------------------------------
  const pre = await control.beginDeployment({
    agentId: agent_id,
    candidateVersion: candidate_version,
  });
  const incumbent = pre.incumbentVersion;

  // --- Shadow soak -----------------------------------------------------------
  phase = 'shadow';
  const shadowSince = (await control.now()).iso;
  await control.deployTransition({
    agentId: agent_id,
    version: candidate_version,
    state: 'shadow',
    reason: `deployment ${deployment_id}`,
  });
  await emit('deployment.started', {
    deployment_id,
    candidate_version,
    incumbent_version: incumbent ?? null,
    initiated_by: req.initiated_by,
    baseline_note: pre.baselineNote,
    config,
  });

  await sleep(config.shadow_soak_s * 1000);
  let shadow = await control.evaluateGate({
    kind: 'shadow',
    tenant,
    since: shadowSince,
    candidateVersion: candidate_version,
    ...(incumbent === undefined ? {} : { incumbentVersion: incumbent }),
    thresholds: config.thresholds,
  });
  if (shadow.verdict === 'insufficient_data') {
    // One more soak, then decide honestly — a gate that still cannot measure
    // does not pass.
    await sleep(config.shadow_soak_s * 1000);
    shadow = await control.evaluateGate({
      kind: 'shadow',
      tenant,
      since: shadowSince,
      candidateVersion: candidate_version,
      ...(incumbent === undefined ? {} : { incumbentVersion: incumbent }),
      thresholds: config.thresholds,
    });
  }
  gateReports.push(shadow);
  if (shadow.verdict !== 'pass') {
    await emit('deployment.failed', { deployment_id, deploy_phase: 'shadow', report: shadow });
    return result('failed', `shadow gate ${shadow.verdict}`, incumbent);
  }

  // --- Canary ramp -----------------------------------------------------------
  phase = 'canary';
  const demoteToShadow = async (why: string, report?: GateReport): Promise<DeploymentResult> => {
    await control.deployTransition({
      agentId: agent_id,
      version: candidate_version,
      state: 'shadow',
      reason: why,
    });
    await emit('deployment.demoted', {
      deployment_id,
      reason: why,
      ...(report === undefined ? {} : { report }),
    });
    await emit('deployment.failed', { deployment_id, deploy_phase: 'canary', reason: why });
    return result('demoted', why, incumbent);
  };

  let i = 0;
  let rollbacks = 0;
  while (i < config.ramp_steps.length) {
    if (isAborted()) return demoteToShadow('deployment aborted mid-canary');
    const ramp = config.ramp_steps[i];
    if (ramp === undefined) break; // unreachable: i < length
    rampPercent = ramp;
    await control.deployTransition({
      agentId: agent_id,
      version: candidate_version,
      state: 'canary',
      rampPercent: ramp,
      reason: `deployment ${deployment_id} ramp ${ramp}%`,
    });
    const rampSince = (await control.now()).iso;
    await emit('deployment.ramped', { deployment_id, ramp_percent: ramp, step_index: i });

    await sleep(config.ramp_soak_s * 1000);
    if (isAborted()) return demoteToShadow('deployment aborted mid-canary');

    const report = await control.evaluateGate({
      kind: 'canary',
      tenant,
      since: rampSince,
      candidateVersion: candidate_version,
      ...(incumbent === undefined ? {} : { incumbentVersion: incumbent }),
      thresholds: config.thresholds,
    });
    gateReports.push(report);

    if (report.verdict === 'pass') {
      rollbacks = 0;
      i += 1;
      continue;
    }
    // A breach (fail) OR a gate that could not measure (insufficient_data) does
    // NOT advance the ramp — fail closed.
    rollbacks += 1;
    if (i === 0 || rollbacks >= 2) {
      // Breach at the first step, or two consecutive breaches → demote.
      return demoteToShadow(
        i === 0 ? 'canary breach at the first ramp step' : 'two consecutive canary breaches',
        report,
      );
    }
    // Roll back one ramp step and retry.
    const prev = config.ramp_steps[i - 1] ?? 0;
    rampPercent = prev;
    await control.deployTransition({
      agentId: agent_id,
      version: candidate_version,
      state: 'canary',
      rampPercent: prev,
      reason: `deployment ${deployment_id} rollback to ${prev}%`,
    });
    await emit('deployment.rolled_back', {
      deployment_id,
      from_ramp: ramp,
      to_ramp: prev,
      report,
    });
    i -= 1;
  }

  // --- Owner approval (R2/R3-capable candidates only) ------------------------
  let approvalId: string | undefined;
  if (pre.requiresApproval) {
    phase = 'approval';
    approvalId = uuid4();
    const { digest } = await control.digestValue({
      from: incumbent ?? null,
      to: candidate_version,
      reports: gateReports.length,
    });
    // Deployment-shaped ApprovalSubject: no task plan (item-1 amendment — plan
    // is optional). task_id is the deployment_id (a uuid); step_id a fresh uuid,
    // both to satisfy the audit schema.
    const subject: ApprovalSubject = {
      approval_id: approvalId,
      task_id: deployment_id,
      step_id: uuid4(),
      tenant: 'platform',
      principal: req.initiated_by,
      agent_id,
      agent_version: candidate_version,
      capability: 'deployment.promote_active',
      risk: 'R2',
      input: {
        from_version: incumbent ?? null,
        to_version: candidate_version,
        gate_reports_digest: digest,
      },
      requested_scopes: [],
    };
    const { subject_digest } = await control.digestApprovalSubject(subject);
    const outcome: ApprovalOutcome = await executeChild(ApprovalWorkflow, {
      workflowId: `approval-${approvalId}`,
      args: [
        {
          subject,
          subject_digest,
          escalate_after_s: APPROVAL_ESCALATE_AFTER_S,
          deny_after_s: APPROVAL_DENY_AFTER_S,
        } satisfies ApprovalGateInput,
      ],
    });
    if (!outcome.granted) {
      return demoteToShadow(`owner approval ${outcome.reason} — promotion refused`);
    }
  }

  // --- Promote + drain -------------------------------------------------------
  phase = 'promote';
  await control.promoteVersion({ agentId: agent_id, version: candidate_version });
  await emit('deployment.promoted', {
    deployment_id,
    from_version: incumbent ?? null,
    to_version: candidate_version,
    gate_reports: gateReports,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
  });

  phase = 'drain';
  await sleep(config.drain_s * 1000);
  if (incumbent !== undefined) {
    await control.deployTransition({
      agentId: agent_id,
      version: incumbent,
      state: 'retired',
      reason: `drained after ${candidate_version} promotion`,
    });
  }

  phase = 'terminal';
  await emit('deployment.completed', {
    deployment_id,
    to_version: candidate_version,
    from_version: incumbent ?? null,
  });
  return result('completed', 'promoted', incumbent, approvalId);
}

/** Builds a deployment-lifecycle audit event (actor = orchestrator, platform tenant). */
function deploymentAudit(
  req: DeploymentRequest,
  candidateVersion: string,
  eventType: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: uuid4(),
    occurred_at: new Date().toISOString(),
    // Lifecycle events are platform infrastructure records.
    tenant: 'platform',
    event_type: eventType,
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: req.initiated_by }, { sub: 'svc:orchestrator' }],
    },
    action: { name: eventType },
    artifacts: {
      agent_id: req.agent_id,
      agent_version: candidateVersion,
      workflow_run_id: workflowInfo().runId,
    },
    details,
  };
}
