import { CapabilityError } from '@acp/agent-sdk';
import { describe, expect, it } from 'vitest';
import { TOOLS_AUDIENCE, toolTokenProvider } from '../src/index.js';

/** A fetch stand-in that records the request and returns a scripted response. */
function fetchReturning(
  status: number,
  body: unknown,
  seen: { url?: string; payload?: Record<string, unknown> },
): typeof fetch {
  return ((url: string, init?: { body?: string }) => {
    seen.url = url;
    seen.payload = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  }) as unknown as typeof fetch;
}

async function failureOf(promise: Promise<unknown>): Promise<CapabilityError> {
  const outcome = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(CapabilityError);
  return outcome as CapabilityError;
}

describe('toolTokenProvider', () => {
  it('exchanges the delegated token toward exactly acp:tools', async () => {
    const seen: { url?: string; payload?: Record<string, unknown> } = {};
    const provider = toolTokenProvider({
      tokenUrl: 'http://token.local',
      clientId: 'agent-cloud-agent',
      clientSecret: 'sekret',
      fetchImpl: fetchReturning(200, { access_token: 'tools-token' }, seen),
    });
    const token = await provider('delegated-token');
    expect(token).toBe('tools-token');
    expect(seen.url).toBe('http://token.local/v1/token/exchange');
    expect(seen.payload).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'agent-cloud-agent',
      client_secret: 'sekret',
      subject_token: 'delegated-token',
      audience: TOOLS_AUDIENCE,
    });
    // The agent never names a foreign actor: no actor/scope params, so the
    // exchange is a same-actor narrowing (idempotent-actor branch).
    expect(seen.payload).not.toHaveProperty('actor');
    expect(seen.payload).not.toHaveProperty('scope');
  });

  it('maps a token-service 4xx to policy_denied', async () => {
    const provider = toolTokenProvider({
      tokenUrl: 'http://token.local',
      clientId: 'agent-cloud-agent',
      clientSecret: 'sekret',
      fetchImpl: fetchReturning(403, { error: 'nope' }, {}),
    });
    const err = await failureOf(provider('delegated-token'));
    expect(err.errorClass).toBe('policy_denied');
    expect(err.message).toContain('403');
  });

  it('maps a network fault to retryable', async () => {
    const provider = toolTokenProvider({
      tokenUrl: 'http://token.local',
      clientId: 'agent-cloud-agent',
      clientSecret: 'sekret',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const err = await failureOf(provider('delegated-token'));
    expect(err.errorClass).toBe('retryable');
    expect(err.message).toContain('ECONNREFUSED');
  });
});
