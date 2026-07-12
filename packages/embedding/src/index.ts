import { createHash } from 'node:crypto';

export const EMBEDDING_DIM = 256;
export const EMBEDDING_MODEL = 'dev-hash-embed@1';

/**
 * Deterministic feature-hashing embedding: unigrams + bigrams hashed into
 * a fixed-dimension signed space, L2-normalized. It is a real (if
 * semantically weak) vector representation that makes hybrid retrieval
 * fully functional offline — dev and CI need no model API, and the
 * lexical leg carries relevance. Provider-backed embeddings slot in
 * behind the same interface; the model name+version column is what makes
 * migrations a designed operation (ADR-0003).
 *
 * Extracted from apps/knowledge (Phase 3 item 6): online-eval drift needs
 * the SAME vectors knowledge stores, so the two must share one byte-identical
 * implementation. The model column (dev-hash-embed@1) is the version pin — a
 * future provider embedding is a new model string, never a silent change here.
 */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): number[];
}

export class HashEmbedder implements Embedder {
  readonly model = EMBEDDING_MODEL;
  readonly dim = EMBEDDING_DIM;

  embed(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIM).fill(0);
    const tokens = tokenize(text);
    const features = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) {
      features.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    for (const feature of features) {
      const digest = createHash('sha256').update(feature).digest();
      const index = digest.readUInt16BE(0) % EMBEDDING_DIM;
      /* v8 ignore next 2 -- defensive ?? on provably in-range indexed access */
      const sign = ((digest[2] ?? 0) & 1) === 1 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => Number((v / norm).toFixed(6)));
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .filter((t) => t.length > 1);
}

/** pgvector literal form. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Cosine similarity of two equal-length vectors. Online-eval drift folds
 * window centroids app-side with this when the DB image predates the
 * pgvector avg() aggregate. Returns 0 for a zero vector (no direction).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine similarity needs equal-length vectors, got ${a.length} and ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    /* v8 ignore next 2 -- defensive ?? on provably in-range indexed access */
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Element-wise mean (centroid) of a set of equal-length vectors. */
export function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return new Array<number>(EMBEDDING_DIM).fill(0);
  const dim = vectors[0]?.length ?? EMBEDDING_DIM;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    /* v8 ignore next -- defensive ?? on provably in-range indexed access */
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
  }
  return sum.map((s) => s / vectors.length);
}
