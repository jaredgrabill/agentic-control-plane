import { EMBEDDING_DIM, toVectorLiteral } from '@acp/embedding';
import type { BudgetObservation, LadderLevel, ScoreIngest } from '@acp/online-eval';
import type pg from 'pg';

/** A persisted quality-state row: the last-recorded ladder level + counters. */
export interface QualityState {
  /** Phase 4 item 1: quality state is keyed (tenant, agent_id) — tenant A's degradation must never freeze agent X for tenant B. */
  tenant: string;
  agent_id: string;
  level: LadderLevel;
  burn_ratio: number;
  consecutive_probe_failures: number;
  consecutive_probe_cycles: number;
  last_drift_at: Date | null;
}

export interface SourceSli {
  judge_mean: number | null;
  probe_pass_rate: number | null;
  human_pass_rate: number | null;
  n_by_source: { judge: number; probe: number; human: number };
}

export interface DriftWindows {
  current: { vectors: number[][]; scores: number[] };
  reference: { vectors: number[][]; scores: number[] };
}

/** How many embedding rows the app-side centroid fold reads per window. */
const CENTROID_ROW_CAP = 500;

/**
 * The online scores store (Postgres + pgvector). Every judged sample, probe
 * result, and human label lands in online_scores; quality_state persists the
 * degradation-ladder level so transitions (not the level itself) drive
 * one-shot actions. The budget is NEVER persisted — it is recomputed from the
 * window on every read, so it self-heals as the window slides.
 */
export class PgScoresStore {
  constructor(private readonly pool: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS online_scores (
        id             uuid PRIMARY KEY,
        agent_id       text NOT NULL,
        agent_version  text NOT NULL,
        capability     text NOT NULL,
        tenant         text NOT NULL,
        task_id        uuid,
        step_id        uuid,
        source         text NOT NULL CHECK (source IN ('judge','probe','human')),
        route          text NOT NULL CHECK (route IN ('active','canary','shadow','probe')),
        score          real,
        passed         boolean,
        weight         real NOT NULL DEFAULT 1,
        rubric         text,
        rubric_digest  text,
        model          text,
        outcome        text,
        input_embedding vector(${EMBEDDING_DIM}),
        recorded_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Phase 4 item 1: every read is tenant-filtered, so the indexes lead with
    // tenant. The old agent-only indexes are dropped (idempotent) — they no
    // longer match any query shape.
    await this.pool.query('DROP INDEX IF EXISTS online_scores_agent_time');
    await this.pool.query('DROP INDEX IF EXISTS online_scores_agent_cap_time');
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS online_scores_tenant_agent_time
         ON online_scores (tenant, agent_id, recorded_at DESC)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS online_scores_tenant_agent_cap_time
         ON online_scores (tenant, agent_id, capability, recorded_at DESC)`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS quality_state (
        tenant         text NOT NULL DEFAULT 'acme',
        agent_id       text NOT NULL,
        level          text NOT NULL DEFAULT 'ok',
        burn_ratio     real NOT NULL DEFAULT 0,
        consecutive_probe_failures int NOT NULL DEFAULT 0,
        consecutive_probe_cycles   int NOT NULL DEFAULT 0,
        last_drift_at  timestamptz,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant, agent_id)
      )
    `);
    // Idempotent migration of a pre-item-1 table (PK was agent_id only, no
    // tenant column): add the column with the historical default, then swap
    // the PK to (tenant, agent_id) ONLY when the current PK is single-column —
    // running migrate twice is a no-op. Closes a real isolation bug: a
    // single-column PK let tenant A's degradation freeze agent X for tenant B.
    await this.pool.query(
      `ALTER TABLE quality_state ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'acme'`,
    );
    await this.pool.query(`
      DO $$
      BEGIN
        IF (SELECT count(*) FROM information_schema.key_column_usage
             WHERE table_name = 'quality_state'
               AND constraint_name = 'quality_state_pkey') = 1 THEN
          ALTER TABLE quality_state DROP CONSTRAINT quality_state_pkey;
          ALTER TABLE quality_state ADD PRIMARY KEY (tenant, agent_id);
        END IF;
      END $$;
    `);
    // Per-tenant budget ledger (Phase 4 item 1). Postgres is AUTHORITATIVE for
    // the running total: admission is a single atomic conditional UPDATE on
    // tenant_budget (row-lock serialized — the anti-TOCTOU primitive), the
    // task.completed consumer moves reserved → committed keyed by task_id, and
    // tenant_budget_charge dedups redeliveries. The gateway creates the same
    // tables idempotently at boot (apps/gateway/src/budget.ts) so neither
    // service depends on the other's start order — keep the DDL in lockstep.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget (
        tenant           text NOT NULL,
        period_start     date NOT NULL,
        cap_micros       bigint NOT NULL,
        committed_micros bigint NOT NULL DEFAULT 0,
        reserved_micros  bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, period_start)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget_reservation (
        task_id      uuid PRIMARY KEY,
        tenant       text NOT NULL,
        period_start date NOT NULL,
        est_micros   bigint NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_budget_charge (
        task_id uuid PRIMARY KEY
      )
    `);
  }

  /** Idempotent insert (ON CONFLICT DO NOTHING). Returns true iff a row was written. */
  async insert(ingest: ScoreIngest): Promise<boolean> {
    const embedding =
      ingest.input_embedding != null ? toVectorLiteral(ingest.input_embedding) : null;
    const res = await this.pool.query(
      `INSERT INTO online_scores
         (id, agent_id, agent_version, capability, tenant, task_id, step_id,
          source, route, score, passed, weight, rubric, rubric_digest, model, outcome,
          input_embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::vector)
       ON CONFLICT (id) DO NOTHING`,
      [
        ingest.id,
        ingest.agent_id,
        ingest.agent_version,
        ingest.capability,
        ingest.tenant,
        ingest.task_id ?? null,
        ingest.step_id ?? null,
        ingest.source,
        ingest.route,
        ingest.score,
        ingest.passed,
        ingest.weight,
        ingest.rubric ?? null,
        ingest.rubric_digest ?? null,
        ingest.model ?? null,
        ingest.outcome ?? null,
        embedding,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** All weighted observations in the window (shadow rows included; the budget excludes them). */
  async budgetObservations(
    tenant: string,
    agentId: string,
    since: Date,
  ): Promise<BudgetObservation[]> {
    const res = await this.pool.query<{
      source: BudgetObservation['source'];
      route: BudgetObservation['route'];
      score: number | null;
      passed: boolean | null;
      weight: number;
    }>(
      `SELECT source, route, score, passed, weight
         FROM online_scores
        WHERE tenant = $1 AND agent_id = $2 AND recorded_at >= $3`,
      [tenant, agentId, since.toISOString()],
    );
    return res.rows;
  }

  /** SLI split by source over the window (judge routes active|canary only for judge_mean). */
  async sli(tenant: string, agentId: string, since: Date): Promise<SourceSli> {
    const res = await this.pool.query<{
      judge_mean: string | null;
      probe_rate: string | null;
      human_rate: string | null;
      judge_n: string;
      probe_n: string;
      human_n: string;
    }>(
      `SELECT
         avg(score) FILTER (WHERE source='judge' AND route IN ('active','canary')) AS judge_mean,
         avg(CASE WHEN passed THEN 1.0 ELSE 0.0 END) FILTER (WHERE source='probe') AS probe_rate,
         avg(CASE WHEN passed THEN 1.0 ELSE 0.0 END) FILTER (WHERE source='human') AS human_rate,
         count(*) FILTER (WHERE source='judge') AS judge_n,
         count(*) FILTER (WHERE source='probe') AS probe_n,
         count(*) FILTER (WHERE source='human') AS human_n
       FROM online_scores
      WHERE tenant = $1 AND agent_id = $2 AND recorded_at >= $3`,
      [tenant, agentId, since.toISOString()],
    );
    const r = res.rows[0];
    const numOrNull = (v: string | null | undefined): number | null =>
      v == null ? null : Number(v);
    return {
      judge_mean: numOrNull(r?.judge_mean),
      probe_pass_rate: numOrNull(r?.probe_rate),
      human_pass_rate: numOrNull(r?.human_rate),
      n_by_source: {
        judge: Number(r?.judge_n ?? 0),
        probe: Number(r?.probe_n ?? 0),
        human: Number(r?.human_n ?? 0),
      },
    };
  }

  /** Mean judged score over active|canary routes in the window (ladder input; null if none). */
  async windowJudgeMean(tenant: string, agentId: string, since: Date): Promise<number | null> {
    const res = await this.pool.query<{ mean: string | null }>(
      `SELECT avg(score) AS mean FROM online_scores
        WHERE tenant=$1 AND agent_id=$2 AND source='judge' AND route IN ('active','canary')
          AND recorded_at >= $3`,
      [tenant, agentId, since.toISOString()],
    );
    const v = res.rows[0]?.mean;
    return v == null ? null : Number(v);
  }

  /**
   * Current vs reference windows for drift, per (agent, capability). Current =
   * [since, now]; reference = [refStart, since]. Only judged rows on production
   * routes with an embedding count. Vectors are folded app-side (cap 500 rows).
   */
  async driftWindows(
    tenant: string,
    agentId: string,
    capability: string,
    since: Date,
    refStart: Date,
  ): Promise<DriftWindows> {
    const load = async (
      from: Date,
      to: Date,
    ): Promise<{ vectors: number[][]; scores: number[] }> => {
      const res = await this.pool.query<{ emb: string | null; score: number | null }>(
        `SELECT input_embedding::text AS emb, score
           FROM online_scores
          WHERE tenant=$1 AND agent_id=$2 AND capability=$3 AND source='judge'
            AND route IN ('active','canary')
            AND input_embedding IS NOT NULL
            AND recorded_at >= $4 AND recorded_at < $5
          ORDER BY recorded_at DESC
          LIMIT ${CENTROID_ROW_CAP}`,
        [tenant, agentId, capability, from.toISOString(), to.toISOString()],
      );
      const vectors: number[][] = [];
      const scores: number[] = [];
      for (const row of res.rows) {
        if (row.emb != null) vectors.push(parseVector(row.emb));
        if (row.score != null) scores.push(row.score);
      }
      return { vectors, scores };
    };
    return {
      current: await load(since, new Date(since.getTime() + 24 * 3600_000 * 3650)),
      reference: await load(refStart, since),
    };
  }

  /** Aggregate mean score by version + route + window (the deployment-gate quality fold). */
  async versionRouteQuality(
    tenant: string,
    agentId: string,
    agentVersion: string,
    route: string,
    since: Date,
  ): Promise<{ mean: number | null; n: number }> {
    const res = await this.pool.query<{ mean: string | null; n: string }>(
      `SELECT avg(score) AS mean, count(*) AS n
         FROM online_scores
        WHERE tenant=$1 AND agent_id=$2 AND agent_version=$3 AND route=$4
          AND source='judge' AND score IS NOT NULL AND recorded_at >= $5`,
      [tenant, agentId, agentVersion, route, since.toISOString()],
    );
    const r = res.rows[0];
    return { mean: r?.mean == null ? null : Number(r.mean), n: Number(r?.n ?? 0) };
  }

  async getQualityState(tenant: string, agentId: string): Promise<QualityState | undefined> {
    const res = await this.pool.query<{
      tenant: string;
      agent_id: string;
      level: LadderLevel;
      burn_ratio: number;
      consecutive_probe_failures: number;
      consecutive_probe_cycles: number;
      last_drift_at: Date | null;
    }>(
      `SELECT tenant, agent_id, level, burn_ratio, consecutive_probe_failures,
              consecutive_probe_cycles, last_drift_at
         FROM quality_state WHERE tenant=$1 AND agent_id=$2`,
      [tenant, agentId],
    );
    return res.rows[0];
  }

  async upsertQualityState(s: QualityState): Promise<void> {
    await this.pool.query(
      `INSERT INTO quality_state
         (tenant, agent_id, level, burn_ratio, consecutive_probe_failures,
          consecutive_probe_cycles, last_drift_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (tenant, agent_id) DO UPDATE SET
         level=$3, burn_ratio=$4, consecutive_probe_failures=$5,
         consecutive_probe_cycles=$6, last_drift_at=$7, updated_at=now()`,
      [
        s.tenant,
        s.agent_id,
        s.level,
        s.burn_ratio,
        s.consecutive_probe_failures,
        s.consecutive_probe_cycles,
        s.last_drift_at?.toISOString() ?? null,
      ],
    );
  }
}

/** Parses a pgvector text literal "[a,b,…]" into a number array. */
export function parseVector(text: string): number[] {
  return text
    .slice(1, -1)
    .split(',')
    .map((s) => Number(s));
}
