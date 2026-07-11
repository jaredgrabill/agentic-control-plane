import { describe, expect, it } from 'vitest';
import { fail, ok, parseToolEnvelope, toCallToolResult } from '../src/index.js';

const PROVENANCE = [
  {
    doc_id: 'cloud/inventory-snapshot',
    version: '2026-07-08',
    lineage_id: '01981c00-0000-7000-8000-0000000000a1',
  },
];

describe('ok / fail builders', () => {
  it('builds a success envelope and omits absent partial/gaps keys', () => {
    expect(ok({ n: 1 }, PROVENANCE)).toEqual({ ok: true, data: { n: 1 }, provenance: PROVENANCE });
    expect(ok({}, [], { partial: true, gaps: ['late'] })).toEqual({
      ok: true,
      data: {},
      provenance: [],
      partial: true,
      gaps: ['late'],
    });
  });

  it('builds a typed error envelope with optional retry_after_s', () => {
    expect(fail('not_found', 'nope')).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'nope' },
    });
    expect(fail('rate_limited', 'slow down', 3)).toEqual({
      ok: false,
      error: { code: 'rate_limited', message: 'slow down', retry_after_s: 3 },
    });
  });
});

describe('toCallToolResult', () => {
  it('mirrors the envelope into structuredContent and content[0].text, sets isError', () => {
    const success = toCallToolResult(ok({ n: 1 }, PROVENANCE));
    expect(success.isError).toBe(false);
    expect(success.structuredContent).toEqual(ok({ n: 1 }, PROVENANCE));
    expect(JSON.parse(success.content[0]!.text)).toEqual(ok({ n: 1 }, PROVENANCE));

    const failure = toCallToolResult(fail('unavailable', 'down'));
    expect(failure.isError).toBe(true);
  });
});

describe('parseToolEnvelope', () => {
  it('round-trips through toCallToolResult (structuredContent path)', () => {
    const envelope = ok({ n: 1 }, PROVENANCE, { partial: true });
    expect(parseToolEnvelope(toCallToolResult(envelope))).toEqual(envelope);
    const error = fail('rate_limited', 'slow', 2);
    expect(parseToolEnvelope(toCallToolResult(error))).toEqual(error);
  });

  it('falls back to envelope JSON in content[0].text', () => {
    const envelope = ok({ via: 'text' }, PROVENANCE);
    expect(
      parseToolEnvelope({ content: [{ type: 'text', text: JSON.stringify(envelope) }] }),
    ).toEqual(envelope);
  });

  it.each([
    ['not a record', 'nope'],
    ['no content and no structuredContent', {}],
    ['non-array content', { content: 'x' }],
    ['content[0] without text', { content: [{ type: 'image' }] }],
    ['unparseable text', { content: [{ type: 'text', text: 'BOOM' }] }],
    ['text parses to a non-record', { content: [{ type: 'text', text: '[1]' }] }],
    ['structuredContent without ok', { structuredContent: { weird: true } }],
    ['ok:true without a data record', { structuredContent: { ok: true, provenance: [] } }],
    [
      'ok:true without a provenance array',
      { structuredContent: { ok: true, data: {}, provenance: 'nope' } },
    ],
    ['ok:false without an error record', { structuredContent: { ok: false } }],
    [
      'unknown error code',
      { structuredContent: { ok: false, error: { code: 'exploded', message: 'x' } } },
    ],
    [
      'non-string error message',
      { structuredContent: { ok: false, error: { code: 'not_found', message: 5 } } },
    ],
  ])('%s → undefined (malformed)', (_name, result) => {
    expect(parseToolEnvelope(result)).toBeUndefined();
  });
});
