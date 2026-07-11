import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth.js';
import { env, envInt, requireEnv } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { createLogger } from '../src/logger.js';

describe('config', () => {
  it('reads, defaults, and fails loudly', () => {
    process.env.ACP_TEST_VAR = 'value';
    expect(requireEnv('ACP_TEST_VAR')).toBe('value');
    expect(env('ACP_TEST_MISSING', 'fallback')).toBe('fallback');
    delete process.env.ACP_TEST_VAR;
    expect(() => requireEnv('ACP_TEST_VAR')).toThrow(/ACP_TEST_VAR/);
  });

  it('parses integers and rejects garbage', () => {
    process.env.ACP_TEST_INT = '42';
    expect(envInt('ACP_TEST_INT', 7)).toBe(42);
    expect(envInt('ACP_TEST_INT_MISSING', 7)).toBe(7);
    process.env.ACP_TEST_INT = 'not-a-number';
    expect(() => envInt('ACP_TEST_INT', 7)).toThrow(/not an integer/);
    delete process.env.ACP_TEST_INT;
  });
});

describe('createHttpServer', () => {
  const logger = createLogger('service-kit-test');

  it('serves health and maps AuthError to its status', async () => {
    const app = createHttpServer({ serviceName: 'test-svc', logger });
    app.get('/boom-auth', () => {
      throw new AuthError('no token', 401);
    });
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({
      status: 'ok',
      service: 'test-svc',
    });
    const res = await app.inject({ url: '/boom-auth' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { message: 'no token', status: 401 } });
  });

  it('hides internals on 500 but keeps the request id', async () => {
    const app = createHttpServer({ serviceName: 'test-svc', logger });
    app.get('/boom', () => {
      throw new Error('secret database string');
    });
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: { message: string; request_id: string } }>();
    expect(body.error.message).toBe('internal error');
    expect(body.error.message).not.toContain('secret');
    expect(body.error.request_id).toBeTruthy();
  });
});
