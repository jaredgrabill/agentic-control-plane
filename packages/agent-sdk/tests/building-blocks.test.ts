import { describe, expect, it } from 'vitest';
import {
  AnswerBuilder,
  CapabilityError,
  ErrorClass,
  FakeModel,
  NatsRetriever,
  TokenExchanger,
  type BusClient,
} from '../src/index.js';

async function capabilityFailure(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CapabilityError);
    return err as CapabilityError;
  }
  throw new Error('expected a CapabilityError');
}

describe('FakeModel', () => {
  it('scripts strings, callables, responses, and errors in order', async () => {
    const model = new FakeModel([
      'plain',
      (prompt) => `echo:${prompt}`,
      { text: 'typed', inputTokens: 5, outputTokens: 7 },
      new CapabilityError(ErrorClass.Retryable, 'simulated 429'),
    ]);
    expect((await model.complete('a')).text).toBe('plain');
    expect((await model.complete('b')).text).toBe('echo:b');
    expect((await model.complete('c')).outputTokens).toBe(7);
    await expect(model.complete('d')).rejects.toThrow('429');
    expect(model.calls).toEqual(['a', 'b', 'c', 'd']);
  });

  it('exhaustion is a loud failure', async () => {
    const model = new FakeModel(['only one']);
    await model.complete('a');
    await expect(model.complete('b')).rejects.toThrow('script exhausted');
  });
});

describe('AnswerBuilder', () => {
  it('deduplicates citations by lineage', () => {
    const builder = new AnswerBuilder();
    const first = builder.cite({ doc_id: 'a', version: '1.0.0', lineage_id: 'x' });
    const second = builder.cite({ doc_id: 'a', version: '1.0.0', lineage_id: 'x' });
    const third = builder.cite({ doc_id: 'b', version: '1.0.0', lineage_id: 'y' });
    expect([first, second, third]).toEqual([1, 1, 2]);
    builder.paragraph('grounded claim [1][2]');
    const answer = builder.build(0.9);
    expect(answer.citations).toHaveLength(2);
    expect(answer.confidence).toBe(0.9);
    expect(answer.abstained).toBeUndefined();
  });

  it('low confidence becomes an abstention', () => {
    const builder = new AnswerBuilder();
    builder.paragraph('weak claim');
    const answer = builder.build(0.1);
    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(answer.text).toContain('sufficient grounding');
  });

  it('abstain clamps confidence to the floor', () => {
    const answer = new AnswerBuilder().abstain('cannot say', 0.9);
    expect(answer.confidence).toBe(0.35);
    expect(new AnswerBuilder().abstain('cannot say').confidence).toBe(0);
  });
});

class FakeNats implements BusClient {
  readonly requests: [string, Record<string, unknown>][] = [];

  constructor(
    private readonly response: Record<string, unknown>,
    private readonly failure?: Error,
  ) {}

  request(subject: string, payload: Uint8Array): Promise<{ data: Uint8Array }> {
    this.requests.push([
      subject,
      JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
    ]);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ data: new TextEncoder().encode(JSON.stringify(this.response)) });
  }
}

function exchanger(handler: (url: string, body: Record<string, unknown>) => Response): {
  exchanger: TokenExchanger;
  seen: { url: string; body: Record<string, unknown> }[];
} {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    seen.push({ url, body });
    return Promise.resolve(handler(url, body));
  };
  return {
    exchanger: new TokenExchanger({
      tokenUrl: 'http://token.test',
      clientId: 'agent-test',
      clientSecret: 's',
      fetchImpl,
    }),
    seen,
  };
}

const tokenOk = (): Response =>
  new Response(JSON.stringify({ access_token: 'knowledge.jwt' }), { status: 200 });

describe('TokenExchanger + NatsRetriever', () => {
  it('exchanges then queries the bus with the minted token', async () => {
    const { exchanger: ok, seen } = exchanger(tokenOk);
    const nc = new FakeNats({
      results: [{ content: 'text', score: 0.03, citation: { doc_id: 'd' } }],
    });
    const retriever = new NatsRetriever({ nc, exchanger: ok });

    const results = await retriever.search('delegated.jwt', 'change freeze', {
      k: 4,
      taskId: 't1',
    });
    expect((results[0]?.citation as Record<string, unknown>).doc_id).toBe('d');

    expect(seen[0]?.url).toBe('http://token.test/v1/token/exchange');
    expect(seen[0]?.body).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'agent-test',
      client_secret: 's',
      subject_token: 'delegated.jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      audience: 'acp:knowledge',
    });

    const [subject, payload] = nc.requests[0]!;
    expect(subject).toBe('acp.platform.svc.knowledge.search');
    expect(payload.token).toBe('knowledge.jwt');
    expect(payload.k).toBe(4);
    expect(payload.task_id).toBe('t1');
    expect(payload.step_id).toBeUndefined();
  });

  it('an exchange refusal is policy_denied', async () => {
    const { exchanger: refuse } = exchanger(() => new Response('no', { status: 403 }));
    const retriever = new NatsRetriever({ nc: new FakeNats({}), exchanger: refuse });
    const err = await capabilityFailure(retriever.search('t', 'q'));
    expect(err.errorClass).toBe('policy_denied');
    expect(err.message).toContain('token exchange for acp:knowledge refused (403)');
  });

  it('search errors map to typed classes', async () => {
    const denied = new NatsRetriever({
      nc: new FakeNats({ error: { status: 403, message: 'Cedar: deny' } }),
      exchanger: exchanger(tokenOk).exchanger,
    });
    expect((await capabilityFailure(denied.search('t', 'q'))).errorClass).toBe('policy_denied');

    const flaky = new NatsRetriever({
      nc: new FakeNats({ error: { status: 500, message: 'db down' } }),
      exchanger: exchanger(tokenOk).exchanger,
    });
    const err = await capabilityFailure(flaky.search('t', 'q'));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('knowledge search failed (500): db down');
  });

  it('a bus timeout is retryable; other bus failures rethrow', async () => {
    const timedOut = new NatsRetriever({
      nc: new FakeNats({}, Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
      exchanger: exchanger(tokenOk).exchanger,
    });
    const err = await capabilityFailure(timedOut.search('t', 'q'));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toBe('knowledge service did not answer within the timeout');

    const broken = new NatsRetriever({
      nc: new FakeNats({}, new Error('connection reset')),
      exchanger: exchanger(tokenOk).exchanger,
    });
    await expect(broken.search('t', 'q')).rejects.toThrow('connection reset');
  });
});
