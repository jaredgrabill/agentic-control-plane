import type { Pool } from 'pg';
import { EMBEDDING_DIM, toVectorLiteral } from './embedding.js';

export interface ChunkRecord {
  lineage_id: string;
  tenant: string;
  source_id: string;
  doc_id: string;
  doc_version: string;
  title: string;
  url: string | null;
  effective_date: string | null;
  classification: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  embedding_model: string;
  embedding: number[];
}

export interface SearchFilters {
  tenant: string;
  /** Classifications the caller may read — the access check lives in the query. */
  classifications: string[];
  sourceId?: string | undefined;
  mode?: 'hybrid' | 'vector' | 'lexical' | undefined;
}

export interface SearchHit {
  lineage_id: string;
  /**
   * The stable source this chunk belongs to. Unlike lineage_id (a fresh
   * UUIDv7 per re-indexed chunk version), source_id survives re-ingestion, so
   * it is the correct handle for the session cache to evict a cached entry
   * when its source mutates (session-cache.ts).
   */
  source_id: string;
  doc_id: string;
  doc_version: string;
  title: string;
  url: string | null;
  effective_date: string | null;
  classification: string;
  content: string;
  score: number;
}

export interface KnowledgeStore {
  /** Returns the existing lineage_id when this exact content is already indexed (hash-based change detection). */
  existingLineage(
    tenant: string,
    docId: string,
    chunkIndex: number,
    contentHash: string,
    embeddingModel: string,
  ): Promise<string | undefined>;
  upsertChunk(record: ChunkRecord): Promise<void>;
  search(
    queryEmbedding: number[],
    queryText: string,
    k: number,
    f: SearchFilters,
  ): Promise<SearchHit[]>;
}

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        lineage_id      uuid PRIMARY KEY,
        tenant          text NOT NULL,
        source_id       text NOT NULL,
        doc_id          text NOT NULL,
        doc_version     text NOT NULL,
        title           text NOT NULL,
        url             text,
        effective_date  date,
        classification  text NOT NULL,
        chunk_index     int NOT NULL,
        content         text NOT NULL,
        content_hash    text NOT NULL,
        embedding_model text NOT NULL,
        embedding       vector(${EMBEDDING_DIM}) NOT NULL,
        fts             tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant, doc_id, chunk_index, embedding_model)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx ON knowledge_chunks USING gin (fts);
      CREATE INDEX IF NOT EXISTS knowledge_chunks_hnsw_idx
        ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX IF NOT EXISTS knowledge_chunks_filter_idx
        ON knowledge_chunks (tenant, classification, source_id);
    `);
  }

  async existingLineage(
    tenant: string,
    docId: string,
    chunkIndex: number,
    contentHash: string,
    embeddingModel: string,
  ): Promise<string | undefined> {
    const res = await this.pool.query<{ lineage_id: string }>(
      `SELECT lineage_id FROM knowledge_chunks
       WHERE tenant=$1 AND doc_id=$2 AND chunk_index=$3 AND content_hash=$4 AND embedding_model=$5`,
      [tenant, docId, chunkIndex, contentHash, embeddingModel],
    );
    return res.rows[0]?.lineage_id;
  }

  async upsertChunk(r: ChunkRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_chunks
         (lineage_id, tenant, source_id, doc_id, doc_version, title, url, effective_date,
          classification, chunk_index, content, content_hash, embedding_model, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector)
       ON CONFLICT (tenant, doc_id, chunk_index, embedding_model)
       DO UPDATE SET lineage_id=$1, source_id=$3, doc_version=$5, title=$6, url=$7,
         effective_date=$8, classification=$9, content=$11, content_hash=$12, embedding=$14::vector`,
      [
        r.lineage_id,
        r.tenant,
        r.source_id,
        r.doc_id,
        r.doc_version,
        r.title,
        r.url,
        r.effective_date,
        r.classification,
        r.chunk_index,
        r.content,
        r.content_hash,
        r.embedding_model,
        toVectorLiteral(r.embedding),
      ],
    );
  }

  /**
   * Hybrid retrieval: lexical (websearch tsquery + ts_rank_cd) and vector
   * (cosine HNSW) legs run as CTEs and fuse with Reciprocal Rank Fusion
   * (k=60) in SQL. Tenant and classification filters apply inside both
   * legs — access control happens in the query, not in the prompt.
   */
  async search(
    queryEmbedding: number[],
    queryText: string,
    k: number,
    f: SearchFilters,
  ): Promise<SearchHit[]> {
    const params: unknown[] = [
      f.tenant,
      f.classifications,
      f.sourceId ?? null,
      toVectorLiteral(queryEmbedding),
      queryText,
      k,
    ];
    const mode = f.mode ?? 'hybrid';
    const vecWeight = mode === 'lexical' ? 0 : 1;
    const lexWeight = mode === 'vector' ? 0 : 1;
    params.push(vecWeight, lexWeight);
    const res = await this.pool.query<SearchHit & { score: string }>(
      `
      WITH filtered AS (
        SELECT * FROM knowledge_chunks
        WHERE tenant = $1 AND classification = ANY($2)
          AND ($3::text IS NULL OR source_id = $3)
      ),
      vec AS (
        SELECT lineage_id, ROW_NUMBER() OVER (ORDER BY embedding <=> $4::vector) AS rank
        FROM filtered ORDER BY embedding <=> $4::vector LIMIT 50
      ),
      lex AS (
        SELECT lineage_id,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', $5)) DESC) AS rank
        FROM filtered
        WHERE fts @@ websearch_to_tsquery('english', $5)
        LIMIT 50
      )
      SELECT c.lineage_id, c.source_id, c.doc_id, c.doc_version, c.title, c.url,
             c.effective_date::text AS effective_date, c.classification, c.content,
             ($7 * COALESCE(1.0/(60 + vec.rank), 0) + $8 * COALESCE(1.0/(60 + lex.rank), 0)) AS score
      FROM filtered c
      LEFT JOIN vec ON vec.lineage_id = c.lineage_id
      LEFT JOIN lex ON lex.lineage_id = c.lineage_id
      WHERE (vec.rank IS NOT NULL AND $7 > 0) OR (lex.rank IS NOT NULL AND $8 > 0)
      ORDER BY score DESC, c.lineage_id
      LIMIT $6
      `,
      params,
    );
    return res.rows.map((r) => ({ ...r, score: Number(r.score) }));
  }
}
