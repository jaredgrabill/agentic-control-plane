import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { createLogger } from '@acp/service-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { FixtureConnector } from '../src/connector.js';
import { HashEmbedder } from '../src/embedding.js';
import { createIngestionActivities } from '../src/ingestion-activities.js';
import type { ChunkRecord, KnowledgeStore, SearchHit } from '../src/store.js';

const logger = createLogger('knowledge-ingest-test');
const MANIFEST = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'acme-corp',
  'corpus.json',
);

class MemoryStore implements KnowledgeStore {
  chunks = new Map<string, ChunkRecord>();
  existingLineage(
    tenant: string,
    docId: string,
    chunkIndex: number,
    contentHash: string,
    embeddingModel: string,
  ): Promise<string | undefined> {
    for (const c of this.chunks.values()) {
      if (
        c.tenant === tenant &&
        c.doc_id === docId &&
        c.chunk_index === chunkIndex &&
        c.content_hash === contentHash &&
        c.embedding_model === embeddingModel
      ) {
        return Promise.resolve(c.lineage_id);
      }
    }
    return Promise.resolve(undefined);
  }
  upsertChunk(record: ChunkRecord): Promise<void> {
    this.chunks.set(record.lineage_id, record);
    return Promise.resolve();
  }
  search(): Promise<SearchHit[]> {
    return Promise.resolve([]);
  }
}

describe('FixtureConnector', () => {
  const connector = new FixtureConnector(MANIFEST);

  it('lists registered documents and refuses unregistered sources/docs', () => {
    expect(connector.tenant).toBe('acme');
    const docs = connector.listDocuments('policy-docs');
    expect(docs.map((d) => d.doc_id)).toContain('policy/change-management');
    expect(() => connector.listDocuments('shadow-source')).toThrow(/registered sources/);
    expect(() => connector.fetch('policy-docs', 'not/registered')).toThrow(/not registered/);
  });

  it('fetches document content with its governance metadata', () => {
    const doc = connector.fetch('policy-docs', 'policy/change-management');
    expect(doc.meta.version).toBe('3.2.0');
    expect(doc.meta.classification).toBe('internal');
    expect(doc.content).toContain('change freeze');
  });
});

describe('ingestion activities', () => {
  let store: MemoryStore;
  let ledger: AuditEvent[];
  let acts: ReturnType<typeof createIngestionActivities>;
  const connector = new FixtureConnector(MANIFEST);

  beforeEach(() => {
    store = new MemoryStore();
    ledger = [];
    acts = createIngestionActivities({
      connector,
      store,
      embedder: new HashEmbedder(),
      audit: {
        publish: (e) => {
          ledger.push(e);
          return Promise.resolve();
        },
      },
      tenant: 'acme',
      logger,
    });
  });

  it('assigns UUIDv7 lineage ids, writes ledger blocks, then indexes — one event per chunk', async () => {
    const doc = await acts.fetchDocument('policy-docs', 'policy/change-management');
    const chunks = await acts.prepareChunks(doc);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.lineage_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
      expect(c.unchanged).toBe(false);
    }

    await acts.writeLedger(doc, chunks);
    expect(ledger).toHaveLength(chunks.length);
    const block = ledger[0]!;
    expect(block.event_type).toBe('corpus.mutation');
    // The ledger stores the raw chunk text plus chunker and embedding
    // versions — reconstructability without re-running any model.
    const details = block.details as Record<string, unknown>;
    expect(details.content).toBe(chunks[0]!.content);
    expect(details.chunker_version).toBe('structure-aware@1');
    expect(details.embedding_model).toBe('dev-hash-embed@1');
    expect(block.artifacts?.lineage_ids).toEqual([chunks[0]!.lineage_id]);

    const indexed = await acts.indexChunks(doc, chunks);
    expect(indexed).toBe(chunks.length);
    expect(store.chunks.size).toBe(chunks.length);
    const record = store.chunks.get(chunks[0]!.lineage_id)!;
    expect(record.doc_version).toBe('3.2.0');
    expect(record.embedding).toHaveLength(new HashEmbedder().dim);
  });

  it('hash-based change detection: unchanged chunks are never re-embedded or re-ledgered', async () => {
    const doc = await acts.fetchDocument('policy-docs', 'policy/change-management');
    const first = await acts.prepareChunks(doc);
    await acts.writeLedger(doc, first);
    await acts.indexChunks(doc, first);
    const eventsAfterFirst = ledger.length;

    const second = await acts.prepareChunks(doc);
    expect(second.every((c) => c.unchanged)).toBe(true);
    // Idempotency: the lineage id is preserved, so replays cannot fork history.
    expect(second.map((c) => c.lineage_id)).toEqual(first.map((c) => c.lineage_id));

    await acts.writeLedger(doc, second);
    const indexed = await acts.indexChunks(doc, second);
    expect(ledger.length).toBe(eventsAfterFirst);
    expect(indexed).toBe(0);
  });
});
