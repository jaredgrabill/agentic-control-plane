import type { AgentCard, EvalBaseline, LifecycleState } from '@acp/protocol';
import { stableStringify } from '@acp/service-kit';
import type { Pool, PoolClient } from 'pg';

export interface AgentFilter {
  capability?: string | undefined;
  state?: LifecycleState | undefined;
}

/** A candidate route (canary) carries its ramp percentage; the shadow/active carry none. */
export interface CandidateRoute {
  card: AgentCard;
  ramp_percent: number;
}

/**
 * The version-aware routing view for one capability: the incumbent `active`
 * card, an optional `canary` (with its ramp) OR `shadow` candidate (never both,
 * by the one_candidate_version invariant). resolveRoute reads exactly this.
 */
export interface RoutingSet {
  active?: AgentCard;
  canary?: CandidateRoute;
  shadow?: AgentCard;
}

/** put() outcome: a new (id,version) row, an idempotent re-register, or a contract conflict. */
export type PutResult =
  | { outcome: 'inserted'; card: AgentCard }
  | { outcome: 'idempotent'; card: AgentCard }
  | { outcome: 'conflict'; existing: AgentCard };

/** A partial-unique-index violation surfaces here so the app can 409 with a helpful message. */
export class InvariantViolation extends Error {
  constructor(
    readonly invariant: 'one_active_version' | 'one_candidate_version',
    message: string,
  ) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

/** Options for a single-version lifecycle transition. */
export interface TransitionOptions {
  /** ramp percentage for canary states; `null` clears it (canary→shadow demotion). */
  rampPercent?: number | null | undefined;
  reason?: string | undefined;
  /** Stamp deployed_at (set exactly when a version enters `active`). */
  setDeployedAt?: boolean | undefined;
  now: string;
}

/**
 * Versioned registry store (debt #3): one row per (agent_id, version). The
 * one_active_version / one_candidate_version partial-unique indexes make the
 * "at most one active, at most one shadow-or-canary candidate" invariants the
 * database's job, not the application's — a racing promote or a double
 * shadow-entry fails atomically at the index.
 */
export interface RegistryStore {
  migrate(): Promise<void>;
  /** Register (id,version). Never touches sibling rows; idempotent on identical contract. */
  put(card: AgentCard): Promise<PutResult>;
  /** Representative card for GET /v1/agents/:id (back-compat): precedence then latest updated_at. */
  get(agentId: string): Promise<AgentCard | undefined>;
  /** Exactly the (agent_id, version) row's card. */
  getVersion(agentId: string, version: string): Promise<AgentCard | undefined>;
  /** All version rows for an agent, newest updated_at first. */
  listVersions(agentId: string): Promise<AgentCard[]>;
  /** Filter across version rows; state=active is still ≤1/agent by the index. */
  list(filter: AgentFilter): Promise<AgentCard[]>;
  /** Version-aware routing view for a capability. */
  routingSet(capability: string): Promise<RoutingSet>;
  /** Transition one version to a new state (partial-index violations → InvariantViolation). */
  transition(
    agentId: string,
    version: string,
    to: LifecycleState,
    opts: TransitionOptions,
  ): Promise<AgentCard>;
  /**
   * Atomic promote: incumbent active→deprecated and candidate canary→active in
   * ONE transaction. Atomicity is forced by one_active_version. Returns both
   * cards (incumbent absent only on a first-ever promotion).
   */
  promote(
    agentId: string,
    candidateVersion: string,
    now: string,
  ): Promise<{ incumbent?: AgentCard; candidate: AgentCard }>;
  /** Record an eval baseline on a specific version's row. */
  putBaseline(agentId: string, version: string, baseline: EvalBaseline): Promise<AgentCard>;
}

/** Representative-card precedence: active first, retired last. */
const STATE_RANK: Record<LifecycleState, number> = {
  active: 0,
  canary: 1,
  shadow: 2,
  deprecated: 3,
  registered: 4,
  suspended: 5,
  retired: 6,
};

interface Row {
  card: AgentCard;
  ramp_percent: number | null;
}

export class PgRegistryStore implements RegistryStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Idempotent DDL at boot. The v0 single-row `agents` table (PK agent_id) is
   * migrated into the versioned `agent_versions` table (PK agent_id,version)
   * and dropped — a one-time copy that no-ops on every subsequent boot.
   */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_versions (
        agent_id     text NOT NULL,
        version      text NOT NULL,
        state        text NOT NULL,
        ramp_percent int,
        card         jsonb NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (agent_id, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_version
        ON agent_versions (agent_id) WHERE state = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS one_candidate_version
        ON agent_versions (agent_id) WHERE state IN ('shadow', 'canary');
      CREATE INDEX IF NOT EXISTS agent_versions_state_idx ON agent_versions (state);

      DO $$
      BEGIN
        IF to_regclass('public.agents') IS NOT NULL THEN
          INSERT INTO agent_versions (agent_id, version, state, card, updated_at)
            SELECT agent_id, version, state, card, updated_at FROM agents
            ON CONFLICT (agent_id, version) DO NOTHING;
          DROP TABLE agents;
        END IF;
      END $$;
    `);
  }

  async put(card: AgentCard): Promise<PutResult> {
    const inserted = await this.pool.query<{ card: AgentCard }>(
      `INSERT INTO agent_versions (agent_id, version, state, ramp_percent, card, updated_at)
       VALUES ($1, $2, $3, NULL, $4, now())
       ON CONFLICT (agent_id, version) DO NOTHING
       RETURNING card`,
      [card.manifest.id, card.version, card.lifecycle_state, JSON.stringify(card)],
    );
    if (inserted.rows[0] !== undefined) {
      return { outcome: 'inserted', card: inserted.rows[0].card };
    }
    // A row already exists for this (id,version). Re-registration is idempotent
    // only when the capability CONTRACT (manifest) is byte-identical; a changed
    // manifest under the same version is a conflict — bump the version.
    const existing = await this.getVersion(card.manifest.id, card.version);
    if (existing === undefined) {
      // Lost a race with a concurrent delete; treat as a fresh insert retry.
      return this.put(card);
    }
    if (stableStringify(existing.manifest) === stableStringify(card.manifest)) {
      return { outcome: 'idempotent', card: existing };
    }
    return { outcome: 'conflict', existing };
  }

  async get(agentId: string): Promise<AgentCard | undefined> {
    const res = await this.pool.query<Row>(
      'SELECT card, ramp_percent FROM agent_versions WHERE agent_id = $1',
      [agentId],
    );
    if (res.rows.length === 0) return undefined;
    const ranked = res.rows
      .map((r) => r.card)
      .sort((a, b) => {
        const byState = STATE_RANK[a.lifecycle_state] - STATE_RANK[b.lifecycle_state];
        if (byState !== 0) return byState;
        return b.updated_at.localeCompare(a.updated_at);
      });
    return ranked[0];
  }

  async getVersion(agentId: string, version: string): Promise<AgentCard | undefined> {
    const res = await this.pool.query<{ card: AgentCard }>(
      'SELECT card FROM agent_versions WHERE agent_id = $1 AND version = $2',
      [agentId, version],
    );
    return res.rows[0]?.card;
  }

  async listVersions(agentId: string): Promise<AgentCard[]> {
    const res = await this.pool.query<{ card: AgentCard }>(
      'SELECT card FROM agent_versions WHERE agent_id = $1 ORDER BY updated_at DESC',
      [agentId],
    );
    return res.rows.map((r) => r.card);
  }

  async list(filter: AgentFilter): Promise<AgentCard[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.state !== undefined) {
      params.push(filter.state);
      clauses.push(`state = $${params.length}`);
    }
    if (filter.capability !== undefined) {
      params.push(filter.capability);
      clauses.push(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(card->'manifest'->'capabilities') c
                 WHERE c->>'name' = $${params.length})`,
      );
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.pool.query<{ card: AgentCard }>(
      `SELECT card FROM agent_versions ${where} ORDER BY agent_id, version`,
      params,
    );
    return res.rows.map((r) => r.card);
  }

  async routingSet(capability: string): Promise<RoutingSet> {
    // Rows serving this capability, in active/canary/shadow states. The
    // one_active_version / one_candidate_version invariants guarantee ≤1 of
    // each per agent; v0 picks the deterministic first agent (min agent_id).
    const res = await this.pool.query<Row>(
      `SELECT card, ramp_percent FROM agent_versions
       WHERE state IN ('active', 'canary', 'shadow')
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(card->'manifest'->'capabilities') c
                     WHERE c->>'name' = $1)
       ORDER BY agent_id, version`,
      [capability],
    );
    const set: RoutingSet = {};
    for (const row of res.rows) {
      const state = row.card.lifecycle_state;
      if (state === 'active' && set.active === undefined) {
        set.active = row.card;
      } else if (state === 'canary' && set.canary === undefined) {
        set.canary = { card: row.card, ramp_percent: row.ramp_percent ?? 0 };
      } else if (state === 'shadow' && set.shadow === undefined) {
        set.shadow = row.card;
      }
    }
    return set;
  }

  async transition(
    agentId: string,
    version: string,
    to: LifecycleState,
    opts: TransitionOptions,
  ): Promise<AgentCard> {
    const current = await this.getVersion(agentId, version);
    if (current === undefined) {
      throw new Error(`no version ${version} of agent ${agentId}`);
    }
    const updated = this.applyTransition(current, to, opts);
    const ramp = opts.rampPercent === undefined ? null : opts.rampPercent;
    try {
      await this.pool.query(
        `UPDATE agent_versions SET state = $3, ramp_percent = $4, card = $5, updated_at = $6
         WHERE agent_id = $1 AND version = $2`,
        [agentId, version, to, ramp, JSON.stringify(updated), opts.now],
      );
    } catch (err) {
      throw mapInvariant(err);
    }
    return updated;
  }

  async promote(
    agentId: string,
    candidateVersion: string,
    now: string,
  ): Promise<{ incumbent?: AgentCard; candidate: AgentCard }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const incumbent = await this.demoteIncumbent(client, agentId, now);
      const candidate = await this.activateCandidate(client, agentId, candidateVersion, now);
      await client.query('COMMIT');
      return { ...(incumbent === undefined ? {} : { incumbent }), candidate };
    } catch (err) {
      await client.query('ROLLBACK');
      throw mapInvariant(err);
    } finally {
      client.release();
    }
  }

  async putBaseline(agentId: string, version: string, baseline: EvalBaseline): Promise<AgentCard> {
    const current = await this.getVersion(agentId, version);
    if (current === undefined) {
      throw new Error(`no version ${version} of agent ${agentId}`);
    }
    const updated: AgentCard = {
      ...current,
      eval_baseline: baseline,
      updated_at: new Date().toISOString(),
    };
    await this.pool.query(
      `UPDATE agent_versions SET card = $3, updated_at = now()
       WHERE agent_id = $1 AND version = $2`,
      [agentId, version, JSON.stringify(updated)],
    );
    return updated;
  }

  private async demoteIncumbent(
    client: PoolClient,
    agentId: string,
    now: string,
  ): Promise<AgentCard | undefined> {
    const res = await client.query<{ card: AgentCard }>(
      `SELECT card FROM agent_versions WHERE agent_id = $1 AND state = 'active'`,
      [agentId],
    );
    const incumbent = res.rows[0]?.card;
    if (incumbent === undefined) return undefined;
    const deprecated: AgentCard = {
      ...incumbent,
      lifecycle_state: 'deprecated',
      updated_at: now,
    };
    await client.query(
      `UPDATE agent_versions SET state = 'deprecated', card = $3, updated_at = $4
       WHERE agent_id = $1 AND version = $2`,
      [agentId, incumbent.version, JSON.stringify(deprecated), now],
    );
    return deprecated;
  }

  private async activateCandidate(
    client: PoolClient,
    agentId: string,
    version: string,
    now: string,
  ): Promise<AgentCard> {
    const res = await client.query<{ card: AgentCard }>(
      `SELECT card FROM agent_versions WHERE agent_id = $1 AND version = $2`,
      [agentId, version],
    );
    const candidate = res.rows[0]?.card;
    if (candidate === undefined) {
      throw new Error(`no version ${version} of agent ${agentId} to promote`);
    }
    if (candidate.lifecycle_state !== 'canary') {
      throw new Error(
        `only a canary version can be promoted; ${agentId}@${version} is ${candidate.lifecycle_state}`,
      );
    }
    const activated: AgentCard = {
      ...candidate,
      lifecycle_state: 'active',
      deployed_at: now,
      updated_at: now,
    };
    await client.query(
      `UPDATE agent_versions SET state = 'active', ramp_percent = NULL, card = $3, updated_at = $4
       WHERE agent_id = $1 AND version = $2`,
      [agentId, version, JSON.stringify(activated), now],
    );
    return activated;
  }

  private applyTransition(
    current: AgentCard,
    to: LifecycleState,
    opts: TransitionOptions,
  ): AgentCard {
    return {
      ...current,
      lifecycle_state: to,
      updated_at: opts.now,
      ...(opts.setDeployedAt === true ? { deployed_at: opts.now } : {}),
      ...(opts.reason !== undefined ? { state_reason: opts.reason } : {}),
    };
  }
}

/** Maps a Postgres partial-unique-index violation to an InvariantViolation, else rethrows. */
function mapInvariant(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') {
    if (e.constraint === 'one_active_version') {
      return new InvariantViolation(
        'one_active_version',
        'another version is already active for this agent — promote or demote it first',
      );
    }
    if (e.constraint === 'one_candidate_version') {
      return new InvariantViolation(
        'one_candidate_version',
        'a shadow or canary candidate already exists for this agent — only one candidate at a time',
      );
    }
  }
  return err;
}
