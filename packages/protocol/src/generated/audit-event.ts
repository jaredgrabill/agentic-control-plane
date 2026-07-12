/* Generated from packages/protocol/schemas — DO NOT EDIT. Run `pnpm gen`. */

/* eslint-disable */

export type Uuid = string;
/**
 * Closed vocabulary; extending it is a protocol change.
 */
export type EventType =
  | 'task.submitted'
  | 'task.planned'
  | 'task.completed'
  | 'step.dispatched'
  | 'step.completed'
  | 'step.skipped'
  | 'policy.decision'
  | 'token.issued'
  | 'token.exchanged'
  | 'token.brokered'
  | 'token.denied'
  | 'bus.auth'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'approval.timeout'
  | 'approval.escalated'
  | 'compensation.started'
  | 'compensation.step_failed'
  | 'compensation.completed'
  | 'task.cancel_requested'
  | 'deployment.started'
  | 'deployment.ramped'
  | 'deployment.rolled_back'
  | 'deployment.promoted'
  | 'deployment.demoted'
  | 'deployment.completed'
  | 'deployment.failed'
  | 'deployment.shadow_result'
  | 'agent.registered'
  | 'agent.lifecycle_changed'
  | 'agent.baseline_recorded'
  | 'corpus.mutation'
  | 'retrieval.served'
  | 'tool.called'
  | 'model.invoked'
  | 'eval.score'
  | 'eval.probe_result'
  | 'eval.drift_detected'
  | 'eval.budget_state_changed'
  | 'killswitch.activated'
  | 'killswitch.cleared'
  | 'task.rejected';
export type Digest = string;

/**
 * One record on the append-only audit stream. Carries who (delegation chain), what (action + digests), why (task, policy decision), and with-what (versioned artifacts) for every governable action.
 */
export interface AuditEvent {
  event_id: Uuid;
  occurred_at: string;
  tenant: string;
  event_type: EventType;
  /**
   * Who acted, with the full delegation chain from token act claims.
   */
  actor: {
    /**
     * Immediate actor (JWT sub): user, service, or agent-version principal.
     */
    principal: string;
    /**
     * Outermost first: user → orchestrator → agent → tool, from nested act claims.
     */
    delegation_chain?: DelegationLink[];
  };
  /**
   * What happened.
   */
  action: {
    /**
     * Action identifier, e.g. capability or tool action name.
     */
    name: string;
    inputs_digest?: Digest;
    outputs_digest?: Digest;
    side_effects?: string[];
  };
  /**
   * Why it was allowed to happen.
   */
  reason?: {
    task_id?: Uuid;
    step_id?: Uuid;
    plan_step?: string;
    policy?: PolicyDecisionRef;
  };
  /**
   * With what: every versioned artifact in force at the time, for replay.
   */
  artifacts?: {
    agent_id?: string;
    agent_version?: string;
    model?: string;
    prompt_template_version?: string;
    /**
     * For retrieval events: the exact chunk versions served.
     */
    lineage_ids?: Uuid[];
    workflow_run_id?: string;
    trace_id?: string;
  };
  /**
   * Event-type-specific payload (e.g. corpus mutation metadata, lifecycle transition).
   */
  details?: {};
}
export interface DelegationLink {
  sub: string;
  role?: string;
  scopes?: string[];
}
export interface PolicyDecisionRef {
  decision: 'allow' | 'deny' | 'require-approval';
  bundle_version: string;
  /**
   * IDs of the policies that matched.
   */
  determining_policies?: string[];
}
