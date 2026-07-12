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
