import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@acp/protocol';
import { sha256Digest, type Logger } from '@acp/service-kit';
import { CHUNKER_VERSION, chunkMarkdown } from './chunker.js';
import type { DocumentMeta, SourceConnector, SourceDocument } from './connector.js';
import type { Embedder } from './embedding.js';
import type { ChunkRecord, KnowledgeStore } from './store.js';
import { uuidv7 } from './uuidv7.js';

export interface PreparedChunk {
  lineage_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  /** Already indexed with identical content — no ledger event, no re-embed. */
  unchanged: boolean;
}

export interface IngestionActivities {
  listDocuments(sourceId: string): Promise<DocumentMeta[]>;
  fetchDocument(sourceId: string, docId: string): Promise<SourceDocument>;
  /** Chunks + assigns lineage ids (UUIDv7) with hash-based change detection. */
  prepareChunks(doc: SourceDocument): Promise<PreparedChunk[]>;
  /**
   * Write 1 of 2: the corpus ledger block, acked by the audit stream
   * BEFORE any vector write. A crash after this leaves audited intent
   * with no serving vector — harmless and retried; the reverse would be
   * a serving vector with no provenance (knowledge-and-rag.md).
   */
  writeLedger(doc: SourceDocument, chunks: PreparedChunk[]): Promise<void>;
  /** Write 2 of 2: embed + upsert into pgvector, keyed by lineage_id. */
  indexChunks(doc: SourceDocument, chunks: PreparedChunk[]): Promise<number>;
}

export interface IngestionDeps {
  connector: SourceConnector;
  store: KnowledgeStore;
  embedder: Embedder;
  audit: { publish(event: AuditEvent): Promise<void> };
  tenant: string;
  logger: Logger;
}

export function createIngestionActivities(deps: IngestionDeps): IngestionActivities {
  return {
    listDocuments(sourceId) {
      return Promise.resolve(deps.connector.listDocuments(sourceId));
    },

    fetchDocument(sourceId, docId) {
      return Promise.resolve(deps.connector.fetch(sourceId, docId));
    },

    async prepareChunks(doc) {
      const prepared: PreparedChunk[] = [];
      for (const chunk of chunkMarkdown(doc.content)) {
        const contentHash = sha256Digest(chunk.content);
        const existing = await deps.store.existingLineage(
          deps.tenant,
          doc.meta.doc_id,
          chunk.index,
          contentHash,
          deps.embedder.model,
        );
        prepared.push({
          lineage_id: existing ?? uuidv7(),
          chunk_index: chunk.index,
          content: chunk.content,
          content_hash: contentHash,
          unchanged: existing !== undefined,
        });
      }
      return prepared;
    },

    async writeLedger(doc, chunks) {
      for (const chunk of chunks) {
        if (chunk.unchanged) continue;
        await deps.audit.publish({
          event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          tenant: deps.tenant,
          event_type: 'corpus.mutation',
          actor: { principal: 'svc:knowledge-ingestion' },
          action: { name: 'corpus.chunk_indexed', inputs_digest: chunk.content_hash },
          artifacts: { lineage_ids: [chunk.lineage_id] },
          details: {
            source_id: doc.meta.source_id,
            doc_id: doc.meta.doc_id,
            doc_version: doc.meta.version,
            chunk_index: chunk.chunk_index,
            chunker_version: CHUNKER_VERSION,
            embedding_model: deps.embedder.model,
            // The ledger stores the raw chunk text: reconstructability must
            // not depend on re-running an embedding model that may no
            // longer exist. Erasure = crypto-shredding, never ledger edits.
            content: chunk.content,
          },
        });
      }
    },

    async indexChunks(doc, chunks) {
      let indexed = 0;
      for (const chunk of chunks) {
        if (chunk.unchanged) continue;
        const record: ChunkRecord = {
          lineage_id: chunk.lineage_id,
          tenant: deps.tenant,
          source_id: doc.meta.source_id,
          doc_id: doc.meta.doc_id,
          doc_version: doc.meta.version,
          title: doc.meta.title,
          url: doc.meta.url,
          effective_date: doc.meta.effective_date,
          classification: doc.meta.classification,
          chunk_index: chunk.chunk_index,
          content: chunk.content,
          content_hash: chunk.content_hash,
          embedding_model: deps.embedder.model,
          embedding: deps.embedder.embed(chunk.content),
        };
        await deps.store.upsertChunk(record);
        indexed += 1;
      }
      deps.logger.info(
        { doc_id: doc.meta.doc_id, indexed, unchanged: chunks.length - indexed },
        'document indexed',
      );
      return indexed;
    },
  };
}
