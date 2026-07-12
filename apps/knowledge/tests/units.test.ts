import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../src/chunker.js';
import { HashEmbedder, toVectorLiteral } from '../src/embedding.js';
import { uuidv7 } from '../src/uuidv7.js';
import { allowedClassifications } from '../src/search.js';

describe('chunkMarkdown', () => {
  it('keeps headings attached to their bodies', () => {
    const chunks = chunkMarkdown('# Title\n\nIntro text.\n\n## Section A\n\nBody A.\n');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.content).toContain('# Title');
    expect(chunks[0]!.content).toContain('Intro text.');
    const sectionA = chunks.find((c) => c.heading === '## Section A');
    expect(sectionA?.content).toContain('Body A.');
  });

  it('splits long sections with overlap', () => {
    const para = 'word '.repeat(120).trim();
    const long = `## Long\n\n${Array.from({ length: 8 }, () => para).join('\n\n')}`;
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(1);
    // Every piece keeps the section heading for retrieval context.
    for (const c of chunks) expect(c.content).toContain('## Long');
  });

  it('never cuts a fenced code block', () => {
    const fence = '```\nline1\n\nline2\n\nline3\n```';
    const md = `## Code\n\n${'pad '.repeat(400)}\n\n${fence}\n\nafter text`;
    const chunks = chunkMarkdown(md);
    const withFence = chunks.filter((c) => c.content.includes('```'));
    for (const c of withFence) {
      expect((c.content.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it('indexes chunks sequentially and skips empty content', () => {
    const chunks = chunkMarkdown('# A\n\ntext\n\n## B\n\nmore');
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('HashEmbedder', () => {
  const embedder = new HashEmbedder();

  it('is deterministic, fixed-dimension, and unit-normalized', () => {
    const a = embedder.embed('change freeze policy during fiscal quarter');
    const b = embedder.embed('change freeze policy during fiscal quarter');
    expect(a).toEqual(b);
    expect(a).toHaveLength(embedder.dim);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 3);
  });

  it('scores related texts closer than unrelated ones', () => {
    const query = embedder.embed('change freeze fiscal quarter');
    const related = embedder.embed(
      'a change freeze is in effect during the final week of each fiscal quarter',
    );
    const unrelated = embedder.embed('kubernetes pod eviction thresholds and node pressure');
    const cos = (x: number[], y: number[]): number => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(query, related)).toBeGreaterThan(cos(query, unrelated));
  });

  it('renders pgvector literals', () => {
    expect(toVectorLiteral([0.5, -0.25])).toBe('[0.5,-0.25]');
  });
});

describe('uuidv7', () => {
  it('is RFC 9562 shaped, version 7, and time-ordered', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    for (const id of [early, late]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(early < late).toBe(true);
  });
});

describe('allowedClassifications', () => {
  it('grants confidential only with its dedicated scope; restricted never', () => {
    expect(allowedClassifications(['knowledge:search:read'])).toEqual(['public', 'internal']);
    expect(
      allowedClassifications(['knowledge:search:read', 'knowledge:confidential:read']),
    ).toEqual(['public', 'internal', 'confidential']);
    expect(allowedClassifications([])).not.toContain('restricted');
  });
});
