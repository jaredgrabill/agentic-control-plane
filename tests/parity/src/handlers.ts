/**
 * TypeScript implementation of fixtures/parity/HANDLERS.md — the normative
 * spec both language runtimes must follow. Change that file first.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';

const DOCS = [
  {
    key: 'freeze',
    docId: 'policy/change-management',
    version: '3.2.0',
    lineageId: '11111111-1111-7111-8111-111111111111',
  },
  {
    key: 'oncall',
    docId: 'runbook/oncall-escalation',
    version: '3.0.0',
    lineageId: '22222222-2222-7222-8222-222222222222',
  },
  {
    key: 'retention',
    docId: 'policy/data-retention',
    version: '1.4.0',
    lineageId: '33333333-3333-7333-8333-333333333333',
  },
] as const;

const ABSTAIN_REASON = "I don't have sufficient grounding in the corpus to answer this reliably.";

export function registerParityHandlers(agent: Agent): void {
  agent.capability('parity.answer', (_ctx, input) => {
    // HANDLERS.md step 1: q = str(input.question or ""). Python-truthiness
    // coercion, not a string typecheck — a numeric question (e.g. 42) must
    // become "42" in both SDKs. Matches Python for strings, numbers,
    // null/undefined (None), 0, and false. (Objects/arrays would stringify
    // differently in the two languages and are not parity-safe inputs; the
    // scalar cast records that assumption.)
    const raw = input.question as string | number | boolean | null | undefined;
    const question = raw ? String(raw) : '';
    if (question === '') {
      return Promise.reject(new CapabilityError(ErrorClass.NeedsInput, 'question is required'));
    }
    const low = question.toLowerCase();
    const builder = agent.answerBuilder();
    if (low.includes('unanswerable')) {
      return Promise.resolve({ ...builder.abstain(ABSTAIN_REASON, 0.1) });
    }
    const matched = DOCS.filter((doc) => low.includes(doc.key));
    if (matched.length === 0) {
      return Promise.resolve({ ...builder.abstain(ABSTAIN_REASON, 0.2) });
    }
    for (const doc of matched) {
      const marker = builder.cite({
        doc_id: doc.docId,
        version: doc.version,
        lineage_id: doc.lineageId,
      });
      builder.paragraph(`Grounded claim about ${doc.key}. [${marker}]`);
    }
    const confidence = Math.min(0.97, 0.6 + 0.15 * matched.length);
    return Promise.resolve({ ...builder.build(confidence) });
  });

  agent.capability('parity.bad_output', () => Promise.resolve({ wrong: true }));
}
