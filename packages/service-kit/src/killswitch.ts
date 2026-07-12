import { KvWatchInclude } from 'nats';
import type { KV, NatsConnection } from 'nats';
import type { Logger } from './logger.js';
import { openKv } from './nats.js';

export const CONTROL_BUCKET = 'acp_control';
const FLEET_KEY = 'killswitch.fleet';
const agentKey = (agentId: string): string => `killswitch.agent.${agentId}`;
/**
 * Principal denylist key (ADR-0007 broker-time check, item 0c). Keyed by the
 * full principal string (agent:{id}@{ver}, user:{id}, svc:{id}). NATS KV keys
 * are dot-delimited tokens, so `:` and `@` are safe but `.` in a principal
 * would split the key — principals use `:`/`@`/`-` only, so this is a stable
 * 1:1 mapping. The watcher's `killswitch.>` prefix already covers it.
 */
const principalKey = (sub: string): string => `killswitch.principal.${sub}`;

export interface KillSwitchState {
  active: boolean;
  reason?: string;
  activated_by?: string;
  activated_at?: string;
}

/**
 * Watches kill-switch flags in the control KV bucket and answers from
 * memory — routers must react in seconds without polling, and a KV outage
 * must not add latency to the request path. The registry event stream is
 * the audited record; this bucket is the fast path.
 */
export class KillSwitchWatcher {
  private readonly state = new Map<string, KillSwitchState>();
  private stopped = false;

  private constructor(
    private readonly kv: KV,
    private readonly logger: Logger,
  ) {}

  static async start(nc: NatsConnection, logger: Logger): Promise<KillSwitchWatcher> {
    const kv = await openKv(nc, CONTROL_BUCKET);
    const watcher = new KillSwitchWatcher(kv, logger);
    // includeHistory delivers current values first, so the watcher is
    // consistent from the moment start() resolves.
    const iter = await kv.watch({ key: 'killswitch.>', include: KvWatchInclude.AllHistory });
    void (async () => {
      for await (const entry of iter) {
        if (watcher.stopped) break;
        if (entry.operation === 'DEL' || entry.operation === 'PURGE') {
          watcher.state.delete(entry.key);
          continue;
        }
        try {
          watcher.state.set(entry.key, JSON.parse(entry.string()) as KillSwitchState);
        } catch {
          logger.error({ key: entry.key }, 'unparseable kill-switch entry ignored');
        }
      }
    })();
    return watcher;
  }

  fleetHalt(): KillSwitchState | undefined {
    const s = this.state.get(FLEET_KEY);
    return s?.active === true ? s : undefined;
  }

  agentSuspension(agentId: string): KillSwitchState | undefined {
    const s = this.state.get(agentKey(agentId));
    return s?.active === true ? s : undefined;
  }

  /**
   * Whether a principal is on the broker-time denylist (ADR-0007). Distinct
   * from agent suspension (keyed by bare agent id): the denylist keys the
   * full principal string, so it revokes a specific agent version, a user,
   * or a service — the token service refuses to delegate/exchange/issue for
   * it, and the NATS auth callout refuses its bus sessions.
   */
  principalDenied(sub: string): KillSwitchState | undefined {
    const s = this.state.get(principalKey(sub));
    return s?.active === true ? s : undefined;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Write side: used by the deployment controller / operator tooling; every flip is audited by the caller. */
export class KillSwitchControl {
  private constructor(private readonly kv: KV) {}

  static async open(nc: NatsConnection): Promise<KillSwitchControl> {
    return new KillSwitchControl(await openKv(nc, CONTROL_BUCKET));
  }

  async suspendAgent(agentId: string, reason: string, activatedBy: string): Promise<void> {
    await this.kv.put(
      agentKey(agentId),
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async reinstateAgent(agentId: string): Promise<void> {
    await this.kv.put(agentKey(agentId), JSON.stringify({ active: false }));
  }

  async haltFleet(reason: string, activatedBy: string): Promise<void> {
    await this.kv.put(
      FLEET_KEY,
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async resumeFleet(): Promise<void> {
    await this.kv.put(FLEET_KEY, JSON.stringify({ active: false }));
  }

  async denyPrincipal(sub: string, reason: string, activatedBy: string): Promise<void> {
    await this.kv.put(
      principalKey(sub),
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async allowPrincipal(sub: string): Promise<void> {
    await this.kv.put(principalKey(sub), JSON.stringify({ active: false }));
  }
}
