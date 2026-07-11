import { describe, expect, it } from 'vitest';
import {
  applyTimeout,
  failureEnvelope,
  forcePartial,
  ok,
  parseFailureDirective,
} from '../src/index.js';

describe('parseFailureDirective grammar', () => {
  it('parses rate_limited with and without a retry-after argument', () => {
    expect(parseFailureDirective('rate_limited')).toEqual({
      kind: 'rate_limited',
      retryAfterS: 1,
    });
    expect(parseFailureDirective('rate_limited:3')).toEqual({
      kind: 'rate_limited',
      retryAfterS: 3,
    });
  });

  it('parses timeout with the 20s default and explicit milliseconds', () => {
    expect(parseFailureDirective('timeout')).toEqual({ kind: 'timeout', ms: 20_000 });
    expect(parseFailureDirective('timeout:500')).toEqual({ kind: 'timeout', ms: 500 });
  });

  it('parses partial and treats empty/missing as no directive', () => {
    expect(parseFailureDirective('partial')).toEqual({ kind: 'partial' });
    expect(parseFailureDirective(undefined)).toBeUndefined();
    expect(parseFailureDirective(null)).toBeUndefined();
    expect(parseFailureDirective('')).toBeUndefined();
  });

  it.each(['explode', 'partial:1', 'timeout:soon', 'rate_limited:-1'])(
    'rejects %s loudly',
    (raw) => {
      expect(() => parseFailureDirective(raw)).toThrow(`unknown failure directive: ${raw}`);
    },
  );
});

describe('directive application', () => {
  it('failureEnvelope only fires for rate_limited', () => {
    expect(failureEnvelope(undefined)).toBeUndefined();
    expect(failureEnvelope({ kind: 'partial' })).toBeUndefined();
    expect(failureEnvelope({ kind: 'rate_limited', retryAfterS: 3 })).toEqual({
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'mock failure directive: rate limited — retry after 3s',
        retry_after_s: 3,
      },
    });
  });

  it('forcePartial marks successful envelopes partial and leaves the rest alone', () => {
    const envelope = ok({ a: 1 }, []);
    expect(forcePartial(envelope, { kind: 'partial' })).toEqual({
      ...envelope,
      partial: true,
      gaps: ['mock failure directive: partial result forced'],
    });
    expect(forcePartial(envelope, undefined)).toBe(envelope);
    expect(forcePartial(envelope, { kind: 'rate_limited', retryAfterS: 1 })).toBe(envelope);
  });

  it('applyTimeout sleeps for the directive duration via the injected sleep', async () => {
    const slept: number[] = [];
    const sleep = (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    };
    await applyTimeout({ kind: 'timeout', ms: 750 }, sleep);
    await applyTimeout(undefined, sleep);
    await applyTimeout({ kind: 'partial' }, sleep);
    expect(slept).toEqual([750]);
  });
});
