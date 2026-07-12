/**
 * The knowledge store's embedding is the shared @acp/embedding
 * implementation (extracted in Phase 3 item 6 so online-eval drift folds the
 * SAME vectors knowledge retrieval stores — one byte-identical model). This
 * module re-exports it so the many in-app importers stay unchanged and the
 * `dev-hash-embed@1` model pin lives in exactly one place.
 */
export {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HashEmbedder,
  toVectorLiteral,
  type Embedder,
} from '@acp/embedding';
