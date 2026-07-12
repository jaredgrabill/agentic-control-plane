import { loadRubric } from '@acp/judge';
import { describe, expect, it } from 'vitest';
import { calibrate } from '../src/service/calibrate.js';

const rubric = loadRubric('answer-quality@1');

/** A fetch that echoes the [[dev-llm]] directive line from the request's variable blocks. */
const devEchoFetch: typeof fetch = (_url, init) => {
  const body = JSON.parse((init as { body: string }).body) as {
    prompt: { variable: { text: string }[] };
  };
  const joined = body.prompt.variable.map((b) => b.text).join('\n');
  const directive = joined.split('\n').find((l) => l.startsWith('[[dev-llm]] '));
  const text = directive !== undefined ? directive.slice('[[dev-llm]] '.length) : 'no verdict here';
  return Promise.resolve(
    new Response(
      JSON.stringify({
        text,
        model_class: 'default-tier',
        model: 'dev-echo@1',
        provider: 'dev',
        model_classes_version: '2026.07',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 1 }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
};

describe('calibrate', () => {
  it('measures agreement 1.0 against the dev cases and passes the floor', async () => {
    const result = await calibrate({
      rubricId: 'answer-quality@1',
      modelClass: 'default-tier',
      minAgreement: 0.85,
      gatewayUrl: 'http://gw.test',
      token: 't',
      dev: true,
      fetchImpl: devEchoFetch,
    });
    expect(result.record.agreement).toBe(1);
    expect(result.record.rubric_digest).toBe(rubric.digest);
    expect(result.passed).toBe(true);
    expect(result.perCase).toHaveLength(4);
  });

  it('fails the floor and counts unparseable verdicts as disagreement', async () => {
    // A gateway that never returns a verdict → every case scores 0 → agreement
    // = fraction of false-labelled cases (2/4 = 0.5) → below the 0.85 floor.
    const blankFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            text: 'no verdict',
            model_class: 'default-tier',
            model: 'dev-echo@1',
            provider: 'dev',
            model_classes_version: '2026.07',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            attempts: [{ provider: 'dev', model: 'dev-echo@1', outcome: 'ok', duration_ms: 1 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const result = await calibrate({
      rubricId: 'answer-quality@1',
      modelClass: 'default-tier',
      minAgreement: 0.85,
      gatewayUrl: 'http://gw.test',
      token: 't',
      dev: true,
      fetchImpl: blankFetch,
    });
    expect(result.passed).toBe(false);
    expect(result.perCase.every((c) => c.outcome === 'unparseable_verdict')).toBe(true);
  });

  it('records a judge_error (score 0) when the gateway throws, and passes citations through', async () => {
    const throwing: typeof fetch = () => Promise.reject(new Error('gateway down'));
    const result = await calibrate({
      rubricId: 'answer-quality@1',
      modelClass: 'default-tier',
      minAgreement: 0.85,
      gatewayUrl: 'http://gw.test',
      token: 't',
      cases: [{ name: 'grounded', input: 'q', output: 'a', citations: ['doc-1'], label: true }],
      fetchImpl: throwing,
    });
    expect(result.perCase[0]?.outcome).toMatch(/judge_error/);
    expect(result.perCase[0]?.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});
