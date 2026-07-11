import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DocumentMeta {
  source_id: string;
  doc_id: string;
  title: string;
  version: string;
  effective_date: string;
  classification: string;
  url: string;
}

export interface SourceDocument {
  meta: DocumentMeta;
  content: string;
}

export interface SourceConnector {
  listDocuments(sourceId: string): DocumentMeta[];
  fetch(sourceId: string, docId: string): SourceDocument;
}

interface CorpusManifest {
  tenant: string;
  sources: {
    source_id: string;
    trust: string;
    documents: (Omit<DocumentMeta, 'source_id'> & { path: string })[];
  }[];
}

/**
 * Registered source connector for the acme-corp fixture corpus: the
 * corpus.json manifest is the source of record (ingestion is the trust
 * gate — only registered connectors feed the corpus; direct writes are
 * disabled by construction: nothing else knows the table).
 */
export class FixtureConnector implements SourceConnector {
  private readonly manifest: CorpusManifest;
  private readonly baseDir: string;

  constructor(manifestPath: string) {
    this.manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
    this.baseDir = dirname(manifestPath);
  }

  get tenant(): string {
    return this.manifest.tenant;
  }

  get sourceIds(): string[] {
    return this.manifest.sources.map((s) => s.source_id);
  }

  listDocuments(sourceId: string): DocumentMeta[] {
    const source = this.manifest.sources.find((s) => s.source_id === sourceId);
    if (source === undefined) {
      throw new Error(
        `unknown source ${sourceId} — registered sources: ${this.sourceIds.join(', ')}`,
      );
    }
    return source.documents.map(({ path, ...meta }) => ({ ...meta, source_id: sourceId }));
  }

  fetch(sourceId: string, docId: string): SourceDocument {
    const source = this.manifest.sources.find((s) => s.source_id === sourceId);
    const doc = source?.documents.find((d) => d.doc_id === docId);
    if (source === undefined || doc === undefined) {
      throw new Error(`document ${docId} is not registered under source ${sourceId}`);
    }
    const { path, ...meta } = doc;
    return {
      meta: { ...meta, source_id: sourceId },
      content: readFileSync(join(this.baseDir, path), 'utf8'),
    };
  }
}
