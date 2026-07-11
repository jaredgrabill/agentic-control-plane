import type { AgentCard, LifecycleState } from '@acp/protocol';
import type { Pool } from 'pg';

export interface AgentFilter {
  capability?: string | undefined;
  state?: LifecycleState | undefined;
}

/** Postgres is the system of record; the KV bucket is only a cache (ADR-0001: no read-your-writes on followers). */
export interface RegistryStore {
  put(card: AgentCard): Promise<void>;
  get(agentId: string): Promise<AgentCard | undefined>;
  list(filter: AgentFilter): Promise<AgentCard[]>;
}

export class PgRegistryStore implements RegistryStore {
  constructor(private readonly pool: Pool) {}

  /** Idempotent DDL at boot: v0 migration story until a real migration tool earns its place. */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id   text PRIMARY KEY,
        version    text NOT NULL,
        state      text NOT NULL,
        card       jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async put(card: AgentCard): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (agent_id, version, state, card, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (agent_id)
       DO UPDATE SET version = $2, state = $3, card = $4, updated_at = now()`,
      [card.manifest.id, card.version, card.lifecycle_state, JSON.stringify(card)],
    );
  }

  async get(agentId: string): Promise<AgentCard | undefined> {
    const res = await this.pool.query<{ card: AgentCard }>(
      'SELECT card FROM agents WHERE agent_id = $1',
      [agentId],
    );
    return res.rows[0]?.card;
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
      `SELECT card FROM agents ${where} ORDER BY agent_id`,
    );
    return res.rows.map((r) => r.card);
  }
}
