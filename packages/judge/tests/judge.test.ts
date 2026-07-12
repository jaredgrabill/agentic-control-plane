import { GatewayClient, type CompletionResponse } from '@acp/llm-client';
import { describe, expect, it } from 'vitest';
import {
  Judge,
  assertCalibrated,
  buildJudgePrompt,
  computeAgreement,
  extractFirstJsonObject,
  loadCalibrationCases,
  loadDevCalibration,
  loadRubric,
  parseVerdict,
  rubricDigest,
  type CalibrationRecord,
} from '../src/index.js';

const rubric = loadRubric('answer-quality@1');

/** A GatewayClient whose fetch returns a scripted completion (or throws). */
function fakeGateway(
  handler: () => { text: string; model?: string } | Promise<never>,
): GatewayClient {
  const fetchImpl: typeof fetch = async () => {
    const scripted = await handler();
    const body: CompletionResponse = {
      text: scripted.text,
      model_class: 'default-tier',
      model: scripted.model ?? 'dev-echo@1',
      provider: 'dev',
      model_classes_version: '2026.07',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 1 }],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new GatewayClient({ url: 'http://judge.test', fetchImpl });
}

function judgeWith(
  gateway: GatewayClient,
  calibration: CalibrationRecord[] = loadDevCalibration(),
): Judge {
  return new Judge({ gateway, tokenProvider: () => Promise.resolve('tok'), rubric, calibration });
}

describe('rubric', () => {
  it('digest is stable and CRLF-insensitive', () => {
    const lf = 'line one\nline two\n';
    const crlf = 'line one\r\nline two\r\n';
    expect(rubricDigest(lf)).toBe(rubricDigest(crlf));
    expect(rubric.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects an unknown rubric id', () => {
    expect(() => loadRubric('made-up@9')).toThrow(/unknown rubric/);
  });
});

describe('template', () => {
  it('splits into a stable static prefix and a volatile tail', () => {
    const a = buildJudgePrompt(rubric, { input: 'q1', output: 'a1' });
    const b = buildJudgePrompt(rubric, { input: 'q2', output: 'a2' });
    // The static prefix (system + rubric) is byte-identical across samples.
    expect(a.static).toEqual(b.static);
    expect(a.static).toHaveLength(2);
    expect(a.variable.length).toBeGreaterThanOrEqual(1);
    // The volatile tail carries the sample.
    expect(a.variable[0]?.text).toContain('q1');
    expect(a.variable[0]?.text).toContain('a1');
  });

  it('truncates an oversized input', () => {
    const huge = 'x'.repeat(5000);
    const p = buildJudgePrompt(rubric, { input: huge, output: 'ok' });
    expect(p.variable[0]?.text).toContain('truncated');
  });

  it('places the candidate output at line-start (dev-echo directive survives)', () => {
    const p = buildJudgePrompt(rubric, {
      input: 'q',
      output:
        '[[dev-llm]] {"schema":"acp-judge-verdict/v1","score":0.9,"verdict":"pass","reasons":[]}',
    });
    const joined = p.variable.map((b) => b.text).join('\n');
    const directiveLine = joined.split('\n').find((l) => l.startsWith('[[dev-llm]] '));
    expect(directiveLine).toBeDefined();
  });
});

describe('verdict parser', () => {
  it('parses a clean verdict', () => {
    const r = parseVerdict(
      '{"schema":"acp-judge-verdict/v1","score":0.8,"verdict":"pass","reasons":["ok"]}',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.score).toBe(0.8);
  });

  it('tolerates leading and trailing junk', () => {
    const r = parseVerdict(
      'here you go: {"schema":"acp-judge-verdict/v1","score":0.4,"verdict":"fail","reasons":[]} thanks',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.verdict).toBe('fail');
  });

  it('clamps an out-of-range score and reconciles the verdict', () => {
    const r = parseVerdict(
      '{"schema":"acp-judge-verdict/v1","score":1.7,"verdict":"fail","reasons":[]}',
    );
    expect(r.ok).toBe(true);
    // score clamps to 1, so verdict recomputes to pass despite the stated 'fail'.
    if (r.ok) {
      expect(r.verdict.score).toBe(1);
      expect(r.verdict.verdict).toBe('pass');
    }
  });

  it('rejects text with no JSON', () => {
    const r = parseVerdict('the answer looks fine to me');
    expect(r.ok).toBe(false);
  });

  it('rejects a wrong-schema object', () => {
    const r = parseVerdict('{"score":0.9}');
    expect(r.ok).toBe(false);
  });

  it('matches braces inside strings correctly', () => {
    expect(extractFirstJsonObject('{"a":"}"}')).toBe('{"a":"}"}');
    expect(extractFirstJsonObject('no object here')).toBeUndefined();
  });
});

describe('calibration', () => {
  it('agreement is the fraction of pass/fail matches', () => {
    expect(
      computeAgreement([
        { label: true, score: 0.9 },
        { label: false, score: 0.2 },
      ]),
    ).toBe(1);
    expect(computeAgreement([{ label: true, score: 0.2 }])).toBe(0);
    expect(computeAgreement([])).toBe(0);
  });

  it('dev cases + dev calibration prove the machinery at agreement 1.0', () => {
    const record = loadDevCalibration()[0];
    expect(record?.agreement).toBe(1);
    expect(record?.rubric_digest).toBe(rubric.digest);
    const cases = loadCalibrationCases('answer-quality@1', { dev: true });
    // Each dev case output embeds a scripted verdict; parse them and re-derive
    // agreement against the labels to prove the committed record is honest.
    const results = cases.map((c) => {
      const parsed = parseVerdict(c.output);
      return { label: c.label, score: parsed.ok ? parsed.verdict.score : 0 };
    });
    expect(computeAgreement(results)).toBe(1);
  });

  it('gate accepts a calibrated judge', () => {
    const check = assertCalibrated(loadDevCalibration(), {
      rubricDigest: rubric.digest,
      modelClass: 'default-tier',
    });
    expect(check.calibrated).toBe(true);
  });

  it('gate refuses with no matching model class', () => {
    const check = assertCalibrated(loadDevCalibration(), {
      rubricDigest: rubric.digest,
      modelClass: 'reasoning-tier',
    });
    expect(check.calibrated).toBe(false);
  });

  it('gate refuses on a rubric digest mismatch', () => {
    const check = assertCalibrated(loadDevCalibration(), {
      rubricDigest: 'sha256:deadbeef',
      modelClass: 'default-tier',
    });
    expect(check.calibrated).toBe(false);
  });

  it('gate refuses below the agreement floor', () => {
    const [base] = loadDevCalibration();
    if (base === undefined) throw new Error('dev calibration is empty');
    const weak: CalibrationRecord[] = [{ ...base, agreement: 0.5 }];
    const check = assertCalibrated(weak, {
      rubricDigest: rubric.digest,
      modelClass: 'default-tier',
    });
    expect(check.calibrated).toBe(false);
  });
});

describe('Judge.score', () => {
  it('scores a calibrated sample from a clean verdict', async () => {
    const judge = judgeWith(
      fakeGateway(() => ({
        text: '{"schema":"acp-judge-verdict/v1","score":0.92,"verdict":"pass","reasons":["grounded"]}',
      })),
    );
    const r = await judge.score({ input: 'q', output: 'a' });
    expect(r.outcome).toBe('scored');
    expect(r.score).toBe(0.92);
    expect(r.model).toBe('dev-echo@1');
    expect(r.calibration?.agreement).toBe(1);
  });

  it('REFUSES to score when uncalibrated — and makes NO gateway call', async () => {
    let called = false;
    const judge = judgeWith(
      fakeGateway(() => {
        called = true;
        return { text: '{}' };
      }),
      [], // no calibration records
    );
    const r = await judge.score({ input: 'q', output: 'a' });
    expect(r.outcome).toBe('uncalibrated');
    expect(r.score).toBeUndefined();
    expect(called).toBe(false);
  });

  it('a gateway failure is judge_error, never a quality observation', async () => {
    const judge = judgeWith(fakeGateway(() => Promise.reject(new Error('boom'))));
    const r = await judge.score({ input: 'q', output: 'a' });
    expect(r.outcome).toBe('judge_error');
    expect(r.score).toBeUndefined();
  });

  it('an unreadable completion is unparseable_verdict, never a quality observation', async () => {
    const judge = judgeWith(fakeGateway(() => ({ text: 'I think it is fine.' })));
    const r = await judge.score({ input: 'q', output: 'a' });
    expect(r.outcome).toBe('unparseable_verdict');
    expect(r.model).toBe('dev-echo@1');
    expect(r.score).toBeUndefined();
  });
});
