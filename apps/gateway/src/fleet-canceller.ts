/**
 * Tier-3 fleet auto-canceller (item 5 — the design-2 deferred NATS
 * auto-canceller, built here because `killswitch.fleet` is the crisp predicate:
 * "cancel every open TaskWorkflow"). It lives in the gateway, which already owns
 * the Temporal client, the item-2 cancel semantics, and the task.cancel_requested
 * audit.
 *
 * On a fleet halt it sweeps the RUNNING TaskWorkflows and, for each, emits a
 * task.cancel_requested (actor svc:gateway, trigger fleet_killswitch) and
 * requests cooperative cancellation. Each cancelled TaskWorkflow then runs its
 * own drain-then-unwind (compensators are exempt from the fleet halt, which is
 * what makes the unwind executable under the halt) and returns an honest
 * `cancelled` result.
 *
 * The sweep repeats every 15s WHILE the halt is active — it catches the
 * intake/flip race (a task that started between two sweeps) and survives a
 * gateway restart mid-halt (the startup check re-arms it). An in-memory
 * per-episode set dedups the audit within one process; a second replica may
 * re-emit a cancel for the same task (idempotent — Temporal cancel is a no-op on
 * an already-cancelling workflow), a documented multi-replica residual.
 *
 * DeploymentWorkflows are deliberately NOT swept (the query targets TaskWorkflow
 * only) — killing a controlled rollout loses ramp state; the runbook says abort
 * deployments manually.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import type { KillSwitchState, Logger } from '@acp/service-kit';

const FLEET_KEY = 'killswitch.fleet';
export const FLEET_SWEEP_INTERVAL_MS = 15_000;
/** The standard-visibility query selecting the workflows a fleet halt cancels. */
export const RUNNING_TASKS_QUERY =
  "WorkflowType = 'TaskWorkflow' AND ExecutionStatus = 'Running'";

/** The kill-switch read side the canceller subscribes to (service-kit KillSwitchWatcher). */
export interface FleetWatcher {
  onFlip(listener: (key: string, state: KillSwitchState | undefined) => void): void;
  fleetHalt(): KillSwitchState | undefined;
}

/** The Temporal client seam: list running TaskWorkflows and cancel one by id. */
export interface FleetCancellerClient {
  /** Async-iterates the workflow ids of RUNNING TaskWorkflows (visibility query). */
  listRunningTaskWorkflowIds(): AsyncIterable<string>;
  /** Requests cooperative cancellation; terminal/absent workflows resolve without throwing. */
  cancel(workflowId: string): Promise<'cancelling' | 'not_found' | 'already_terminal'>;
}

export interface FleetCancellerAudit {
  publish(event: AuditEvent): Promise<void>;
}

export interface FleetCancellerDeps {
  watcher: FleetWatcher;
  client: FleetCancellerClient;
  audit: FleetCancellerAudit;
  logger: Logger;
  /** Sweep cadence while the halt is active (default 15s; overridable for tests). */
  sweepIntervalMs?: number;
  now?: () => Date;
}

const TASK_WORKFLOW_PREFIX = 'task-';
/** taskId is a fixed-length uuid, so the tenant is everything between the prefix and the trailing -uuid. */
const TRAILING_UUID_LEN = 37; // '-' + 36-char uuid

/**
 * Splits `task-{tenant}-{taskId}` back into its parts. taskId is a fixed-length
 * uuid, so `slice(5, -37)` is the tenant and `slice(-36)` the task id — the
 * inverse of gateway/src/temporal.ts taskWorkflowId(). Returns undefined for a
 * workflow id that does not match the shape (never a TaskWorkflow we own).
 */
export function parseTaskWorkflowId(
  workflowId: string,
): { tenant: string; taskId: string } | undefined {
  if (!workflowId.startsWith(TASK_WORKFLOW_PREFIX)) return undefined;
  if (workflowId.length <= TASK_WORKFLOW_PREFIX.length + TRAILING_UUID_LEN) return undefined;
  if (workflowId[workflowId.length - TRAILING_UUID_LEN] !== '-') return undefined;
  const tenant = workflowId.slice(TASK_WORKFLOW_PREFIX.length, -TRAILING_UUID_LEN);
  const taskId = workflowId.slice(-(TRAILING_UUID_LEN - 1));
  if (tenant === '') return undefined;
  return { tenant, taskId };
}

export class FleetCanceller {
  private sweeping = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Task workflow ids cancelled in the CURRENT halt episode (audit dedup). */
  private cancelledThisEpisode = new Set<string>();
  private readonly intervalMs: number;

  constructor(private readonly deps: FleetCancellerDeps) {
    this.intervalMs = deps.sweepIntervalMs ?? FLEET_SWEEP_INTERVAL_MS;
  }

  /**
   * Subscribes to fleet flips and, if the halt is ALREADY active at startup
   * (restart survival — the onFlip listener does not replay history), begins
   * sweeping immediately.
   */
  start(): void {
    this.deps.watcher.onFlip((key, state) => {
      if (key !== FLEET_KEY) return;
      if (state?.active === true) this.beginSweeping();
      else this.stopSweeping();
    });
    if (this.deps.watcher.fleetHalt() !== undefined) this.beginSweeping();
  }

  stop(): void {
    this.stopped = true;
    this.stopSweeping();
  }

  private beginSweeping(): void {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    // Fresh episode: a new halt re-cancels tasks that started under a prior one.
    this.cancelledThisEpisode = new Set();
    this.deps.logger.warn('fleet halt active — auto-cancelling in-flight TaskWorkflows');
    // Sweep immediately, then on the interval while active.
    void this.sweepOnce();
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, this.intervalMs);
    // Do not keep the process alive solely for the sweep timer.
    this.timer.unref?.();
  }

  private stopSweeping(): void {
    if (!this.sweeping) return;
    this.sweeping = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.deps.logger.info('fleet halt cleared — auto-canceller idle');
  }

  /**
   * One sweep: list running TaskWorkflows, and for each not yet cancelled this
   * episode, emit task.cancel_requested then request cancellation. Idempotent —
   * a terminal or already-cancelling workflow is skipped. Never throws; a listing
   * or cancel error is logged and the sweep continues (the next tick retries).
   */
  async sweepOnce(): Promise<void> {
    const halt = this.deps.watcher.fleetHalt();
    if (halt === undefined) {
      // The halt cleared between the trigger and this sweep — stand down.
      this.stopSweeping();
      return;
    }
    try {
      for await (const workflowId of this.deps.client.listRunningTaskWorkflowIds()) {
        if (this.cancelledThisEpisode.has(workflowId)) continue;
        const parsed = parseTaskWorkflowId(workflowId);
        if (parsed === undefined) continue; // not a TaskWorkflow id we own
        this.cancelledThisEpisode.add(workflowId);
        try {
          await this.emitCancelRequested(parsed.tenant, parsed.taskId, halt);
          const outcome = await this.deps.client.cancel(workflowId);
          this.deps.logger.info(
            { workflowId, tenant: parsed.tenant, task_id: parsed.taskId, outcome },
            'fleet auto-cancel requested',
          );
        } catch (err) {
          this.deps.logger.error(
            { workflowId, err },
            'fleet auto-cancel failed for a task (will retry next sweep)',
          );
          // Allow a retry next sweep: the audit + cancel did not complete.
          this.cancelledThisEpisode.delete(workflowId);
        }
      }
    } catch (err) {
      this.deps.logger.error({ err }, 'fleet auto-cancel sweep listing failed — retrying next tick');
    }
  }

  private async emitCancelRequested(
    tenant: string,
    taskId: string,
    halt: KillSwitchState,
  ): Promise<void> {
    await this.deps.audit.publish({
      event_id: randomUUID(),
      occurred_at: (this.deps.now?.() ?? new Date()).toISOString(),
      tenant,
      event_type: 'task.cancel_requested',
      actor: { principal: 'svc:gateway', delegation_chain: [{ sub: 'svc:gateway' }] },
      action: { name: 'task.cancel_requested' },
      reason: { task_id: taskId },
      details: {
        trigger: 'fleet_killswitch',
        ...(halt.activated_by === undefined ? {} : { activated_by: halt.activated_by }),
        ...(halt.reason === undefined ? {} : { reason: halt.reason }),
      },
    });
  }
}
