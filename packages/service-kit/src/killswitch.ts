import { KvWatchInclude } from 'nats';
import type { KV, NatsConnection } from 'nats';
import type { Logger } from './logger.js';
import { openKv } from './nats.js';

export const CONTROL_BUCKET = 'acp_control';
const FLEET_KEY = 'killswitch.fleet';
const agentKey = (agentId: string): string => `killswitch.agent.${agentId}`;
/**
 * Tier-2 capability flag key. Capability names are `[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*`
 * (e.g. change.submit) — all KV-legal characters (`.` and `_` plus alphanumerics),
 * so no encoding is needed and there is no collision with the agent-id namespace.
 */
const capabilityKey = (name: string): string => `killswitch.capability.${name}`;
/** Tier-2 risk-class flag key. Class ∈ {R1,R2,R3} (R0 is refused at the flip surface). */
const riskKey = (riskClass: string): string => `killswitch.risk.${riskClass}`;
/**
 * Per-tenant halt key family (Phase 4 item 1): a fleet halt scoped to ONE
 * tenant. Tenant ids are `[a-z0-9-]+` (KV-legal — no `.`/`:`/`@`), so unlike
 * the principal key no encoding is needed and the tenant reads back verbatim
 * from the key. Covered by the watcher's `killswitch.>` prefix.
 */
export const KILLSWITCH_TENANT_PREFIX = 'killswitch.tenant.';
const tenantKey = (tenant: string): string =>
  `${KILLSWITCH_TENANT_PREFIX}${assertTenantId(tenant)}`;

const TENANT_ID_RE = /^[a-z0-9-]+$/;

/**
 * Guards every tenant-keyed kill-switch write/read: only `[a-z0-9-]+` is a
 * tenant id (the same alphabet the NATS subject builders enforce), so a
 * crafted "tenant" can never smuggle a KV wildcard, another key family, or an
 * encoding ambiguity into the control bucket. Returns the id for inline use.
 */
export function assertTenantId(tenant: string): string {
  if (!TENANT_ID_RE.test(tenant)) {
    throw new Error(
      `tenant id ${JSON.stringify(tenant)} is not valid — expected /^[a-z0-9-]+$/`,
    );
  }
  return tenant;
}

/**
 * The tenant a `killswitch.tenant.{tenant}` key targets, or undefined for any
 * other key (the fleet canceller uses this to map flips to halt predicates).
 */
export function tenantOfKillSwitchKey(key: string): string | undefined {
  if (!key.startsWith(KILLSWITCH_TENANT_PREFIX)) return undefined;
  const tenant = key.slice(KILLSWITCH_TENANT_PREFIX.length);
  return TENANT_ID_RE.test(tenant) ? tenant : undefined;
}

/** Risk rank: a flag on class C blocks every executing risk with rank ≥ rank(C). */
const RISK_RANK: Record<string, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };
/** Risk classes a flag may target — R0 is never a valid target (halt the fleet instead). */
export const FLAGGABLE_RISK_CLASSES = ['R1', 'R2', 'R3'] as const;
const rankOf = (risk: string): number => RISK_RANK[risk] ?? 3;
/**
 * Principal denylist key (ADR-0007 broker-time check, item 0c). Keyed by the
 * full principal string (agent:{id}@{ver}, user:{id}, svc:{id}). NATS KV keys
 * forbid `:` and `@` (only `-/_=.` plus alphanumerics), so the principal is
 * base64url-encoded into the last token — an alphabet the KV accepts, applied
 * identically on write (denyPrincipal) and read (principalDenied), so no
 * caller ever handles the encoded form. The watcher's `killswitch.>` prefix
 * still covers it.
 */
const principalKey = (sub: string): string =>
  `killswitch.principal.${Buffer.from(sub, 'utf8').toString('base64url')}`;

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
  private readonly flipListeners: ((key: string, state: KillSwitchState | undefined) => void)[] =
    [];
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
          watcher.notifyFlip(entry.key, undefined);
          continue;
        }
        try {
          const next = JSON.parse(entry.string()) as KillSwitchState;
          watcher.state.set(entry.key, next);
          watcher.notifyFlip(entry.key, next);
        } catch {
          logger.error({ key: entry.key }, 'unparseable kill-switch entry ignored');
        }
      }
    })();
    return watcher;
  }

  /**
   * Registers a listener invoked on every kill-switch KV change (the raw key
   * and the parsed state, or undefined on delete). The fleet auto-canceller
   * (item 5) subscribes to react to a fleet halt without polling. History
   * entries delivered before the listener registers are NOT replayed to it —
   * a subscriber that must act on an already-active flag reads the state
   * directly (e.g. fleetHalt()) at startup.
   */
  onFlip(listener: (key: string, state: KillSwitchState | undefined) => void): void {
    this.flipListeners.push(listener);
  }

  private notifyFlip(key: string, state: KillSwitchState | undefined): void {
    for (const listener of this.flipListeners) {
      try {
        listener(key, state);
      } catch (err) {
        this.logger.error({ key, err }, 'kill-switch flip listener threw (ignored)');
      }
    }
  }

  fleetHalt(): KillSwitchState | undefined {
    const s = this.state.get(FLEET_KEY);
    return s?.active === true ? s : undefined;
  }

  /**
   * Whether a single tenant is halted (Phase 4 item 1): a fleet halt scoped to
   * one tenant — gates NEW intake and NEW bus sessions and drives the
   * auto-canceller for that tenant only; monotonic and compensator-exempt
   * exactly like the fleet tier. The tenant is validated so an unexpected
   * caller value can never read a foreign key family.
   */
  tenantHalt(tenant: string): KillSwitchState | undefined {
    const s = this.state.get(tenantKey(tenant));
    return s?.active === true ? s : undefined;
  }

  /**
   * Every tenant with an ACTIVE tenant halt, keyed by tenant id. The fleet
   * auto-canceller reads this at startup (restart survival — onFlip does not
   * replay history) and on each sweep to decide which tenants a halt covers.
   */
  activeTenantHalts(): Map<string, KillSwitchState> {
    const halts = new Map<string, KillSwitchState>();
    for (const [key, state] of this.state) {
      if (!state.active) continue;
      const tenant = tenantOfKillSwitchKey(key);
      if (tenant !== undefined) halts.set(tenant, state);
    }
    return halts;
  }

  agentSuspension(agentId: string): KillSwitchState | undefined {
    const s = this.state.get(agentKey(agentId));
    return s?.active === true ? s : undefined;
  }

  /** Tier-2: whether a specific capability is suspended by name (blocks it even during compensation). */
  capabilitySuspension(name: string): KillSwitchState | undefined {
    const s = this.state.get(capabilityKey(name));
    return s?.active === true ? s : undefined;
  }

  /**
   * Tier-2: whether an EXECUTING risk class is blocked by an active risk-class
   * flag. Monotonic — a flag on class C blocks every executing risk with rank
   * ≥ rank(C), so `killswitch.risk.R2` blocks R2 and R3 but not R1. Returns the
   * first (lowest-class) active flag that covers the executing risk.
   */
  riskClassSuspension(risk: string): KillSwitchState | undefined {
    const execRank = rankOf(risk);
    for (const cls of FLAGGABLE_RISK_CLASSES) {
      if (execRank < rankOf(cls)) continue;
      const s = this.state.get(riskKey(cls));
      if (s?.active === true) return s;
    }
    return undefined;
  }

  /**
   * Tier-2 convenience: a capability named `name` executing at declared `risk`
   * is halted if EITHER its own capability flag OR a covering risk-class flag
   * is active. The named flag is checked first so a surgical suspension is the
   * reported reason.
   */
  capabilityHalt(name: string, risk: string): KillSwitchState | undefined {
    return this.capabilitySuspension(name) ?? this.riskClassSuspension(risk);
  }

  /**
   * Whether a principal is on the broker-time denylist (ADR-0007). Distinct
   * from agent suspension (keyed by bare agent id): the denylist keys the
   * full principal string, so it revokes a specific agent version, a user,
   * or a service. Enforced at every checkpoint: the token service refuses to
   * delegate/exchange for it and refuses ANY principal's client_credentials
   * issuance (0c QA MEDIUM — no longer agent-only), the NATS auth callout
   * refuses its bus sessions, and the tool gateway refuses its in-flight
   * calls (backstop, so an outstanding ≤15min token cannot outlive the
   * denylisting).
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

  /**
   * Per-tenant halt (Phase 4 item 1): a fleet halt scoped to exactly one
   * tenant. Platform-admin CLI only — there is no self-serve write surface,
   * and enforcement always matches this key against a VERIFIED tenant
   * (claims.tenant at the callout/gateway, the parsed workflow-id tenant at
   * the canceller), never a caller-supplied parameter.
   */
  async haltTenant(tenant: string, reason: string, activatedBy: string): Promise<void> {
    await this.kv.put(
      tenantKey(tenant),
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async resumeTenant(tenant: string): Promise<void> {
    await this.kv.put(tenantKey(tenant), JSON.stringify({ active: false }));
  }

  /** Tier-2: suspend a single capability by name (surgical — blocks even compensators). */
  async suspendCapability(name: string, reason: string, activatedBy: string): Promise<void> {
    await this.kv.put(
      capabilityKey(name),
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async reinstateCapability(name: string): Promise<void> {
    await this.kv.put(capabilityKey(name), JSON.stringify({ active: false }));
  }

  /**
   * Tier-2: suspend a whole risk class (blocks every executing risk with rank ≥
   * this class). R0 is refused — there is no read-only class worth flagging;
   * halt the fleet instead.
   */
  async suspendRiskClass(riskClass: string, reason: string, activatedBy: string): Promise<void> {
    assertFlaggableRisk(riskClass);
    await this.kv.put(
      riskKey(riskClass),
      JSON.stringify({
        active: true,
        reason,
        activated_by: activatedBy,
        activated_at: new Date().toISOString(),
      } satisfies KillSwitchState),
    );
  }

  async reinstateRiskClass(riskClass: string): Promise<void> {
    assertFlaggableRisk(riskClass);
    await this.kv.put(riskKey(riskClass), JSON.stringify({ active: false }));
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

/** Rejects R0 (and any non-{R1,R2,R3}) as a risk-class flag target. */
export function assertFlaggableRisk(riskClass: string): void {
  if (!(FLAGGABLE_RISK_CLASSES as readonly string[]).includes(riskClass)) {
    throw new Error(
      `risk class ${JSON.stringify(riskClass)} cannot be kill-switched — only ` +
        `${FLAGGABLE_RISK_CLASSES.join(', ')} (R0 is read-only; halt the fleet instead)`,
    );
  }
}
