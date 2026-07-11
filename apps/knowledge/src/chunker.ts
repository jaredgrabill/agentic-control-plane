export const CHUNKER_VERSION = 'structure-aware@1';

export interface Chunk {
  index: number;
  content: string;
  heading: string | null;
}

const TARGET_WORDS = 300;
const MAX_WORDS = 480;
const OVERLAP_WORDS = 40;

/**
 * Structure-aware Markdown chunking (knowledge-and-rag.md): headings open
 * new chunks and stay attached to their body, long sections split on
 * paragraph boundaries with ~12% overlap, and fenced code blocks are never
 * cut mid-fence.
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const sections = splitSections(markdown);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const piece of splitLong(section.body)) {
      const content = (section.heading !== null ? `${section.heading}\n\n` : '') + piece.trim();
      if (content.trim() === '') continue;
      chunks.push({ index: chunks.length, content, heading: section.heading });
    }
  }
  return chunks;
}

interface Section {
  heading: string | null;
  body: string;
}

function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (body.join('\n').trim() !== '' || heading !== null) {
      sections.push({ heading, body: body.join('\n') });
    }
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && /^#{1,4}\s/.test(line)) {
      flush();
      heading = line.trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

function splitLong(body: string): string[] {
  const words = body.split(/\s+/).filter((w) => w !== '').length;
  if (words <= MAX_WORDS) return [body];

  // Split on paragraph boundaries, respecting code fences as atomic units.
  const paragraphs = paragraphize(body);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).filter((w) => w !== '').length;
    if (currentWords + paraWords > TARGET_WORDS && current.length > 0) {
      pieces.push(current.join('\n\n'));
      // Overlap: carry the tail of the previous piece into the next one so
      // boundary-straddling facts stay retrievable.
      const tail = current.join(' ').split(/\s+/).slice(-OVERLAP_WORDS).join(' ');
      current = tail === '' ? [] : [`… ${tail}`];
      currentWords = OVERLAP_WORDS;
    }
    current.push(para);
    currentWords += paraWords;
  }
  if (current.length > 0) pieces.push(current.join('\n\n'));
  return pieces;
}

function paragraphize(body: string): string[] {
  const rawParas: string[] = [];
  let fence: string[] = [];
  let inFence = false;
  for (const block of body.split(/\n{2,}/)) {
    const fenceCount = (block.match(/```/g) ?? []).length;
    if (inFence) {
      fence.push(block);
      if (fenceCount % 2 === 1) {
        rawParas.push(fence.join('\n\n'));
        fence = [];
        inFence = false;
      }
    } else if (fenceCount % 2 === 1) {
      inFence = true;
      fence = [block];
    } else {
      rawParas.push(block);
    }
  }
  if (fence.length > 0) rawParas.push(fence.join('\n\n'));
  return rawParas.filter((p) => p.trim() !== '');
}
