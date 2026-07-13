/**
 * Tier-3 fleet auto-canceller (item 5 — the design-2 deferred NATS
 * auto-canceller, built here because `killswitch.fleet` is the crisp predicate:
 * "cancel every open TaskWorkflow"). It lives in the gateway, which already owns
 * the Temporal client, the item-2 cancel semantics, and the task.cancel_requested
 * audit.
 *
 * Phase 4 item 1 generalizes it to per-tenant halts: `killswitch.tenant.{t}`
 * is a fleet halt scoped to ONE tenant, so the sweep now cancels a running
 * TaskWorkflow iff ANY active halt covers its tenant — the fleet halt covers
 * every tenant, a tenant halt covers exactly the tenant parsed back out of the
 * workflow id (`task-{tenant}-{taskId}`, the gateway's own id scheme — never a
 * caller-supplied parameter).
 *
 * On a halt it sweeps the RUNNING TaskWorkflows and, for each covered one,
 * emits a task.cancel_requested (actor svc:gateway, trigger fleet_killswitch or
 * tenant_killswitch) and requests cooperative cancellation. Each cancelled
 * TaskWorkflow then runs its own drain-then-unwind (compensators are exempt
 * from the halt, which is what makes the unwind executable under it) and
 * returns an honest `cancelled` result.
 *
 * The sweep repeats every 15s WHILE any halt is active — it catches the
 * intake/flip race (a task that started between two sweeps) and survives a
 * gateway restart mid-halt (the startup check re-arms it). An in-memory
 * PER-HALT-KEY dedup set bounds the audit within one process and one halt
 * episode: clearing a tenant halt resets only that tenant's episode (a fleet
 * episode in flight keeps its own dedup), and a re-halt re-cancels tasks that
 * survived a prior one. A second replica may re-emit a cancel for the same
 * task (idempotent — Temporal cancel is a no-op on an already-cancelling
 * workflow), a documented multi-replica residual; likewise a task cancelled
 * under a fleet halt may get one extra idempotent cancel from a still-active
 * tenant halt after the fleet halt clears.
 *
 * DeploymentWorkflows are deliberately NOT swept (the query targets TaskWorkflow
 * only) — killing a controlled rollout loses ramp state; the runbook says abort
 * deployments manually.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { tenantOfKillSwitchKey, type KillSwitchState, type Logger } from '@acp/service-kit';

const FLEET_KEY = 'killswitch.fleet';
export const FLEET_SWEEP_INTERVAL_MS = 15_000;
/** The standard-visibility query selecting the workflows a halt sweep inspects. */
export const RUNNING_TASKS_QUERY = "WorkflowType = 'TaskWorkflow' AND ExecutionStatus = 'Running'";

/** The kill-switch read side the canceller subscribes to (service-kit KillSwitchWatcher). */
export interface FleetWatcher {
  onFlip(listener: (key: string, state: KillSwitchState | undefined) => void): void;
  fleetHalt(): KillSwitchState | undefined;
  /** Every tenant with an ACTIVE per-tenant halt, keyed by tenant id. */
  activeTenantHalts(): Map<string, KillSwitchState>;
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

/** An active halt paired with the KV key and audit trigger it enforces under. */
interface CoveringHalt {
  key: string;
  state: KillSwitchState;
  trigger: 'fleet_killswitch' | 'tenant_killswitch';
}

export class FleetCanceller {
  private sweeping = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Task workflow ids cancelled under each halt key's CURRENT episode (audit
   * dedup). Per-halt-key so clearing a tenant halt never resets a fleet
   * episode (and vice versa); a key's set is dropped when its halt clears.
   */
  private cancelledByHaltKey = new Map<string, Set<string>>();
  private readonly intervalMs: number;

  constructor(private readonly deps: FleetCancellerDeps) {
    this.intervalMs = deps.sweepIntervalMs ?? FLEET_SWEEP_INTERVAL_MS;
  }

  /**
   * Subscribes to fleet + tenant halt flips and, if any halt is ALREADY active
   * at startup (restart survival — the onFlip listener does not replay
   * history), begins sweeping immediately.
   */
  start(): void {
    this.deps.watcher.onFlip((key, state) => {
      if (key !== FLEET_KEY && tenantOfKillSwitchKey(key) === undefined) return;
      if (state?.active === true) {
        // Fresh episode FOR THIS KEY: a re-halt re-cancels tasks that started
        // (or survived) under a prior episode of the same key.
        this.cancelledByHaltKey.delete(key);
        this.beginSweeping();
      } else {
        this.cancelledByHaltKey.delete(key);
        if (!this.anyHaltActive()) this.stopSweeping();
      }
    });
    if (this.anyHaltActive()) this.beginSweeping();
  }

  stop(): void {
    this.stopped = true;
    this.stopSweeping();
  }

  private anyHaltActive(): boolean {
    return (
      this.deps.watcher.fleetHalt() !== undefined || this.deps.watcher.activeTenantHalts().size > 0
    );
  }

  private beginSweeping(): void {
    if (this.stopped) return;
    if (this.sweeping) {
      // Already sweeping (another halt is active) — the next tick picks the
      // new halt up from the watcher; nothing to re-arm.
      void this.sweepOnce();
      return;
    }
    this.sweeping = true;
    this.deps.logger.warn('kill-switch halt active — auto-cancelling covered TaskWorkflows');
    // Sweep immediately, then on the interval while active.
    void this.sweepOnce();
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, this.intervalMs);
    // Do not keep the process alive solely for the sweep timer.
    this.timer.unref();
  }

  private stopSweeping(): void {
    if (!this.sweeping) return;
    this.sweeping = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.deps.logger.info('all halts cleared — auto-canceller idle');
  }

  /**
   * The first active halt covering a task's tenant: the fleet halt (covers
   * everyone) wins over a tenant halt so the broader reason is the audited
   * trigger. Returns undefined when no active halt covers the tenant.
   */
  private coveringHalt(
    tenant: string,
    fleet: KillSwitchState | undefined,
    tenants: Map<string, KillSwitchState>,
  ): CoveringHalt | undefined {
    if (fleet !== undefined) {
      return { key: FLEET_KEY, state: fleet, trigger: 'fleet_killswitch' };
    }
    const tenantHalt = tenants.get(tenant);
    if (tenantHalt !== undefined) {
      return {
        key: `killswitch.tenant.${tenant}`,
        state: tenantHalt,
        trigger: 'tenant_killswitch',
      };
    }
    return undefined;
  }

  /**
   * One sweep: list running TaskWorkflows, and for each covered by an active
   * halt and not yet cancelled under that halt's episode, emit
   * task.cancel_requested then request cancellation. Idempotent — a terminal
   * or already-cancelling workflow is skipped. Never throws; a listing or
   * cancel error is logged and the sweep continues (the next tick retries).
   */
  async sweepOnce(): Promise<void> {
    const fleet = this.deps.watcher.fleetHalt();
    const tenants = this.deps.watcher.activeTenantHalts();
    if (fleet === undefined && tenants.size === 0) {
      // Every halt cleared between the trigger and this sweep — stand down.
      this.stopSweeping();
      return;
    }
    try {
      for await (const workflowId of this.deps.client.listRunningTaskWorkflowIds()) {
        const parsed = parseTaskWorkflowId(workflowId);
        if (parsed === undefined) continue; // not a TaskWorkflow id we own
        const halt = this.coveringHalt(parsed.tenant, fleet, tenants);
        if (halt === undefined) continue; // no active halt covers this tenant
        let episode = this.cancelledByHaltKey.get(halt.key);
        if (episode === undefined) {
          episode = new Set();
          this.cancelledByHaltKey.set(halt.key, episode);
        }
        if (episode.has(workflowId)) continue;
        episode.add(workflowId);
        try {
          await this.emitCancelRequested(parsed.tenant, parsed.taskId, halt);
          const outcome = await this.deps.client.cancel(workflowId);
          this.deps.logger.info(
            {
              workflowId,
              tenant: parsed.tenant,
              task_id: parsed.taskId,
              trigger: halt.trigger,
              outcome,
            },
            'kill-switch auto-cancel requested',
          );
        } catch (err) {
          this.deps.logger.error(
            { workflowId, err },
            'kill-switch auto-cancel failed for a task (will retry next sweep)',
          );
          // Allow a retry next sweep: the audit + cancel did not complete.
          episode.delete(workflowId);
        }
      }
    } catch (err) {
      this.deps.logger.error(
        { err },
        'kill-switch auto-cancel sweep listing failed — retrying next tick',
      );
    }
  }

  private async emitCancelRequested(
    tenant: string,
    taskId: string,
    halt: CoveringHalt,
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
        trigger: halt.trigger,
        ...(halt.state.activated_by === undefined ? {} : { activated_by: halt.state.activated_by }),
        ...(halt.state.reason === undefined ? {} : { reason: halt.state.reason }),
      },
    });
  }
}
