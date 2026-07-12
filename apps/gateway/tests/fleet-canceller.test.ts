import type { AuditEvent } from '@acp/protocol';
import { createLogger, type KillSwitchState } from '@acp/service-kit';
import { describe, expect, it } from 'vitest';
import {
  FleetCanceller,
  parseTaskWorkflowId,
  type FleetCancellerClient,
  type FleetWatcher,
} from '../src/fleet-canceller.js';

const logger = createLogger('fleet-canceller-test');
const flush = () => new Promise((r) => setImmediate(r));
const UUID = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';

/** A togglable fleet watcher recording its onFlip listener. */
class FakeWatcher implements FleetWatcher {
  private listener: ((key: string, state: KillSwitchState | undefined) => void) | undefined;
  state: KillSwitchState | undefined;
  onFlip(l: (key: string, state: KillSwitchState | undefined) => void): void {
    this.listener = l;
  }
  fleetHalt(): KillSwitchState | undefined {
    return this.state?.active === true ? this.state : undefined;
  }
  flip(state: KillSwitchState | undefined): void {
    this.state = state;
    this.listener?.('killswitch.fleet', state);
  }
  /** A non-fleet flip must be ignored by the canceller. */
  flipOther(): void {
    this.listener?.('killswitch.capability.change.submit', { active: true });
  }
}

class FakeClient implements FleetCancellerClient {
  running: string[] = [];
  cancelled: string[] = [];
  failCancelOnce = false;
  // eslint-disable-next-line @typescript-eslint/require-await
  async *listRunningTaskWorkflowIds(): AsyncIterable<string> {
    for (const id of this.running) yield id;
  }
  cancel(workflowId: string): Promise<'cancelling' | 'not_found' | 'already_terminal'> {
    if (this.failCancelOnce) {
      this.failCancelOnce = false;
      return Promise.reject(new Error('transient temporal error'));
    }
    this.cancelled.push(workflowId);
    return Promise.resolve('cancelling');
  }
}

function harness() {
  const watcher = new FakeWatcher();
  const client = new FakeClient();
  const audit: AuditEvent[] = [];
  const canceller = new FleetCanceller({
    watcher,
    client,
    audit: {
      publish: (e) => {
        audit.push(e);
        return Promise.resolve();
      },
    },
    logger,
    // A huge interval so the setInterval never fires during a test; we drive
    // sweepOnce directly or via the immediate sweep beginSweeping runs.
    sweepIntervalMs: 3_600_000,
  });
  return { watcher, client, audit, canceller };
}

describe('parseTaskWorkflowId (dashed-tenant slice pin)', () => {
  it('splits task-{tenant}-{uuid} back into tenant + taskId', () => {
    expect(parseTaskWorkflowId(`task-acme-${UUID}`)).toEqual({ tenant: 'acme', taskId: UUID });
  });
  it('handles a dashed tenant (the slice is anchored on the fixed-length trailing uuid)', () => {
    expect(parseTaskWorkflowId(`task-acme-corp-eu-${UUID}`)).toEqual({
      tenant: 'acme-corp-eu',
      taskId: UUID,
    });
  });
  it('rejects ids that are not a task workflow shape', () => {
    expect(parseTaskWorkflowId(`deploy-cloud-agent`)).toBeUndefined();
    expect(parseTaskWorkflowId(`approval-${UUID}`)).toBeUndefined();
    expect(parseTaskWorkflowId(`task-${UUID}`)).toBeUndefined(); // no tenant segment
  });
});

describe('FleetCanceller', () => {
  const halt = (over: Partial<KillSwitchState> = {}): KillSwitchState => ({
    active: true,
    reason: 'p1 incident',
    activated_by: 'user:ops',
    ...over,
  });

  it('sweeps running TaskWorkflows: audits then cancels, parsing the tenant', async () => {
    const { watcher, client, audit, canceller } = harness();
    watcher.state = halt();
    client.running = [`task-acme-${UUID}`, `task-beta-corp-${UUID}`];
    await canceller.sweepOnce();

    expect(client.cancelled).toEqual([`task-acme-${UUID}`, `task-beta-corp-${UUID}`]);
    const events = audit.filter((e) => e.event_type === 'task.cancel_requested');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tenant: 'acme',
      actor: { principal: 'svc:gateway' },
      reason: { task_id: UUID },
      details: { trigger: 'fleet_killswitch', activated_by: 'user:ops', reason: 'p1 incident' },
    });
    expect(events[1]!.tenant).toBe('beta-corp');
  });

  it('never queries or cancels DeploymentWorkflows or other non-task ids', async () => {
    const { watcher, client, canceller } = harness();
    watcher.state = halt();
    client.running = [`deploy-cloud-agent`, `approval-${UUID}`, `task-acme-${UUID}`];
    await canceller.sweepOnce();
    // Only the TaskWorkflow id was cancelled.
    expect(client.cancelled).toEqual([`task-acme-${UUID}`]);
  });

  it('dedups within one halt episode but re-cancels after a resume+halt', async () => {
    const { watcher, client, audit, canceller } = harness();
    client.running = [`task-acme-${UUID}`];
    canceller.start(); // registers the onFlip listener (state starts inactive)

    watcher.flip(halt());
    await flush(); // immediate sweep
    await canceller.sweepOnce(); // same episode → no second cancel
    expect(client.cancelled).toEqual([`task-acme-${UUID}`]);

    // Resume then halt again = fresh episode → the still-running task is re-cancelled.
    watcher.flip({ active: false });
    watcher.flip(halt());
    await flush();
    expect(client.cancelled).toEqual([`task-acme-${UUID}`, `task-acme-${UUID}`]);
    expect(audit.filter((e) => e.event_type === 'task.cancel_requested')).toHaveLength(2);
    canceller.stop();
  });

  it('a cancel error leaves the task un-deduped so the next sweep retries it', async () => {
    const { watcher, client, canceller } = harness();
    watcher.state = halt();
    client.running = [`task-acme-${UUID}`];
    client.failCancelOnce = true;
    await canceller.sweepOnce(); // cancel throws → not recorded, not deduped
    expect(client.cancelled).toEqual([]);
    await canceller.sweepOnce(); // retry succeeds
    expect(client.cancelled).toEqual([`task-acme-${UUID}`]);
  });

  it('stands down when the halt cleared between the trigger and the sweep', async () => {
    const { watcher, client, canceller } = harness();
    watcher.state = undefined; // not active
    client.running = [`task-acme-${UUID}`];
    await canceller.sweepOnce();
    expect(client.cancelled).toEqual([]);
  });

  it('start() begins sweeping on a fleet flip and ignores non-fleet flips', async () => {
    const { watcher, client, canceller } = harness();
    client.running = [`task-acme-${UUID}`];
    canceller.start();

    // A non-fleet flip does nothing.
    watcher.flipOther();
    await flush();
    expect(client.cancelled).toEqual([]);

    // A fleet halt triggers the immediate sweep.
    watcher.flip(halt());
    await flush();
    expect(client.cancelled).toEqual([`task-acme-${UUID}`]);
    canceller.stop();
  });

  it('start() re-arms if the halt is already active at startup (restart survival)', async () => {
    const { watcher, client, canceller } = harness();
    watcher.state = halt();
    client.running = [`task-acme-${UUID}`];
    canceller.start();
    await flush();
    expect(client.cancelled).toEqual([`task-acme-${UUID}`]);
    canceller.stop();
  });
});
