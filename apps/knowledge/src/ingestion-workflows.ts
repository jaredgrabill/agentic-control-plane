/** Deterministic Temporal workflow code — effects live in activities. */
import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { IngestionActivities } from './ingestion-activities.js';

const activities = proxyActivities<IngestionActivities>({
  startToCloseTimeout: '60 seconds',
  retry: { maximumAttempts: 5 },
});

export interface IngestionResult {
  doc_id: string;
  chunks: number;
  indexed: number;
}

/**
 * fetch → chunk (assign lineage_id) → ledger write → embed+index
 * (knowledge-and-rag.md). Retries guarantee ledger and index converge;
 * lineage_id is the idempotency key for both writes, so replays cannot
 * fork history.
 */
export async function IngestionWorkflow(sourceId: string, docId: string): Promise<IngestionResult> {
  const doc = await activities.fetchDocument(sourceId, docId);
  const chunks = await activities.prepareChunks(doc);
  await activities.writeLedger(doc, chunks);
  const indexed = await activities.indexChunks(doc, chunks);
  return { doc_id: docId, chunks: chunks.length, indexed };
}

export interface SourceIngestionResult {
  source_id: string;
  documents: IngestionResult[];
}

/** One child workflow per document: per-document retry isolation and history. */
export async function IngestSourceWorkflow(sourceId: string): Promise<SourceIngestionResult> {
  const docs = await activities.listDocuments(sourceId);
  const documents: IngestionResult[] = [];
  for (const doc of docs) {
    documents.push(
      await executeChild(IngestionWorkflow, {
        args: [sourceId, doc.doc_id],
        workflowId: `${workflowInfo().workflowId}-${doc.doc_id.replaceAll('/', '-')}`,
      }),
    );
  }
  return { source_id: sourceId, documents };
}
