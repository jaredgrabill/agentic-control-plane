import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HashEmbedder,
  centroid,
  cosineSimilarity,
  toVectorLiteral,
} from '../src/index.js';

describe('HashEmbedder', () => {
  const embedder = new HashEmbedder();

  it('pins the model and dimension', () => {
    expect(embedder.model).toBe('dev-hash-embed@1');
    expect(EMBEDDING_MODEL).toBe('dev-hash-embed@1');
    expect(embedder.dim).toBe(EMBEDDING_DIM);
  });

  it('is deterministic and normalized', () => {
    const a = embedder.embed('the vacation policy grants twenty days');
    const b = embedder.embed('the vacation policy grants twenty days');
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 4);
  });

  it('returns a zero vector for text with no tokens', () => {
    const v = embedder.embed('  !  ');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('places similar text nearer than dissimilar text', () => {
    const base = embedder.embed('cloud cost report for the finance team');
    const near = embedder.embed('cloud cost report for finance');
    const far = embedder.embed('vacation policy days off holidays');
    expect(cosineSimilarity(base, near)).toBeGreaterThan(cosineSimilarity(base, far));
  });
});

describe('vector helpers', () => {
  it('renders a pgvector literal', () => {
    expect(toVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });

  it('cosine of a zero vector is 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('cosine of identical direction is 1', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('rejects mismatched lengths', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/equal-length/);
  });

  it('averages vectors into a centroid', () => {
    expect(centroid([[0, 2], [2, 4]])).toEqual([1, 3]);
    expect(centroid([])).toHaveLength(EMBEDDING_DIM);
  });
});
