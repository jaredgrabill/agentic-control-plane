import { describe, expect, it } from 'vitest';
import { fail, ok, toCallToolResult } from '../src/index.js';

const PROV = [{ doc_id: 'd', version: '1', lineage_id: 'l' }];

describe('envelope helpers', () => {
  it('ok() carries data + provenance and only sets partial/gaps when given', () => {
    expect(ok({ a: 1 }, PROV)).toEqual({ ok: true, data: { a: 1 }, provenance: PROV });
    expect(ok({}, PROV, { partial: true, gaps: ['g'] })).toEqual({
      ok: true,
      data: {},
      provenance: PROV,
      partial: true,
      gaps: ['g'],
    });
  });

  it('fail() carries the typed code and optional retry_after_s', () => {
    expect(fail('not_found', 'nope')).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'nope' },
    });
    expect(fail('rate_limited', 'slow', 3)).toEqual({
      ok: false,
      error: { code: 'rate_limited', message: 'slow', retry_after_s: 3 },
    });
  });

  it('toCallToolResult mirrors the envelope into structuredContent and text, isError on failures', () => {
    const success = toCallToolResult(ok({ a: 1 }, PROV));
    expect(success.isError).toBe(false);
    expect(success.structuredContent).toEqual(ok({ a: 1 }, PROV));
    expect(JSON.parse(success.content[0]!.text)).toEqual(ok({ a: 1 }, PROV));

    const failure = toCallToolResult(fail('invalid_input', 'bad'));
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toEqual(fail('invalid_input', 'bad'));
  });
});
