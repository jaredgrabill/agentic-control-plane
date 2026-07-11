/**
 * AnswerBuilder: makes the compliant answer shape (text + citations +
 * confidence, abstention as a success mode) the path of least resistance.
 */

import type { Answer, Citation } from '@acp/protocol';

/**
 * Answers below this confidence must abstain rather than guess
 * (knowledge-and-rag.md); agents may only raise the floor.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.35;

/**
 * Round-half-away-from-zero to 4 decimals. Deliberately NOT Python's
 * banker's rounding — parity fixtures avoid ties so both SDKs agree
 * (see fixtures/parity/HANDLERS.md).
 */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export class AnswerBuilder {
  readonly confidenceFloor: number;
  private readonly paragraphs: string[] = [];
  private readonly citations: Citation[] = [];

  constructor(confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR) {
    this.confidenceFloor = confidenceFloor;
  }

  /**
   * Registers a citation and returns its 1-based marker number.
   *
   * The same lineage_id cites once — repeated grounding on one chunk should
   * not inflate the citation list.
   */
  cite(citation: Citation): number {
    for (const [i, existing] of this.citations.entries()) {
      if (existing.lineage_id === citation.lineage_id) return i + 1;
    }
    this.citations.push(citation);
    return this.citations.length;
  }

  paragraph(text: string): void {
    this.paragraphs.push(text.trim());
  }

  /** Below the floor this abstains; on success `abstained` is omitted entirely. */
  build(confidence: number): Answer {
    if (confidence < this.confidenceFloor) {
      return this.abstain(
        "I don't have sufficient grounding in the corpus to answer this reliably.",
        confidence,
      );
    }
    return {
      text: this.paragraphs.join('\n\n'),
      citations: this.citations,
      confidence: round4(confidence),
    };
  }

  /** Abstention is a success mode, never a confident guess. */
  abstain(reason: string, confidence = 0): Answer {
    return {
      text: reason,
      citations: [],
      confidence: round4(Math.min(confidence, this.confidenceFloor)),
      abstained: true,
    };
  }
}
