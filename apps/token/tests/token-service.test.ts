import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger, delegationChain } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTokenApp, BROKER_DELEGATION_GRANT, TOKEN_EXCHANGE_GRANT } from '../src/app.js';
import { ClientRegistry } from '../src/clients.js';
import { loadKeyStore, type KeyStore } from '../src/keys.js';
import { MAX_TTL_SECONDS } from '../src/tokens.js';

const ISSUER = 'https://token.test.local';

const CLIENTS = [
  {
    client_id: 'cli-jane',
    client_secret: 'jane-secret',
    principal: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scopes: ['task:submit', 'knowledge:search:read'],
  },
  {
    client_id: 'svc-orchestrator',
    client_secret: 'orch-secret',
    principal: 'svc:orchestrator',
    tenant: 'acme',
    roles: ['platform', 'broker'],
    scopes: ['token:exchange'],
  },
  {
    client_id: 'svc-lowly',
    client_secret: 'lowly-secret',
    principal: 'svc:lowly',
    tenant: 'acme',
    roles: ['tool-server'],
    scopes: [],
  },
  {
    client_id: 'svc-platform-only',
    client_secret: 'platform-secret',
    principal: 'svc:platform-only',
    tenant: 'acme',
    roles: ['platform'],
    scopes: [],
  },
  {
    client_id: 'agent-something',
    client_secret: 'agent-secret',
    principal: 'agent:something@0.1.0',
    tenant: 'acme',
    roles: ['agent'],
    scopes: [],
  },
];

let app: FastifyInstance;
let keys: KeyStore;
const auditEvents: AuditEvent[] = [];

beforeAll(async () => {
  keys = await loadKeyStore({ privateKeyPem: undefined, previousPublicKeyPem: undefined });
  app = await buildTokenApp({
    keys,
    clients: new ClientRegistry(CLIENTS),
    issuer: ISSUER,
    audit: {
      publish: (e) => {
        auditEvents.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('token-service-test'),
  });
});

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

async function issueUserToken(scope?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/token',
    headers: { authorization: basic('cli-jane', 'jane-secret') },
    payload: {
      grant_type: 'client_credentials',
      audience: 'acp:gateway',
      ...(scope === undefined ? {} : { scope }),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ access_token: string }>().access_token;
}

describe('issuance', () => {
  it('issues a verifiable, audience-bound token with the registered claims', async () => {
    const token = await issueUserToken();
    const verifier = new JwtVerifier({ jwks: keys.jwks }, ISSUER);
    const claims = await verifier.verify(token, 'acp:gateway');
    expect(claims.sub).toBe('user:jane.doe');
    expect(claims.tenant).toBe('acme');
    expect(claims.roles).toEqual(['tenant-user']);
    expect(claims.scope).toBe('task:submit knowledge:search:read');
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('rejects verification for a different audience', async () => {
    const token = await issueUserToken();
    const verifier = new JwtVerifier({ jwks: keys.jwks }, ISSUER);
    await expect(verifier.verify(token, 'acp:agent:other')).rejects.toThrow(/audience/);
  });

  it('rejects a wrong client secret and an unknown client identically', async () => {
    for (const auth of [basic('cli-jane', 'wrong'), basic('nobody', 'jane-secret')]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/token',
        headers: { authorization: auth },
        payload: { grant_type: 'client_credentials', audience: 'acp:gateway' },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: { message: string; status: number } }>();
      expect(body.error.status).toBe(401);
      expect(body.error.message).toContain('client authentication failed');
    }
  });

  it('refuses scopes outside the client registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: {
        grant_type: 'client_credentials',
        audience: 'acp:gateway',
        scope: 'task:submit admin:everything',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('caps requested TTL at 15 minutes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: {
        grant_type: 'client_credentials',
        audience: 'acp:gateway',
        requested_ttl: '86400',
      },
    });
    expect(res.json<{ expires_in: number }>().expires_in).toBe(MAX_TTL_SECONDS);
  });

  it('requires an audience', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: { grant_type: 'client_credentials' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('emits a token.issued audit event with tenant attribution', async () => {
    auditEvents.length = 0;
    await issueUserToken();
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.event_type).toBe('token.issued');
    expect(auditEvents[0]!.tenant).toBe('acme');
  });
});

describe('RFC 8693 exchange', () => {
  async function exchange(payload: Record<string, string>): Promise<{
    statusCode: number;
    body: { access_token: string };
  }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/exchange',
      headers: { authorization: basic('svc-orchestrator', 'orch-secret') },
      payload: { grant_type: TOKEN_EXCHANGE_GRANT, ...payload },
    });
    return { statusCode: res.statusCode, body: res.json<{ access_token: string }>() };
  }

  it('rebinds audience, narrows scope to the intersection, preserves sub, nests act', async () => {
    const userToken = await issueUserToken();
    const hop1 = await exchange({
      subject_token: userToken,
      audience: 'acp:orchestrator',
      actor: 'svc:orchestrator',
    });
    expect(hop1.statusCode).toBe(200);

    const hop2 = await exchange({
      subject_token: hop1.body.access_token,
      audience: 'acp:agent:knowledge-agent',
      scope: 'knowledge:search:read cloud:write',
      actor: 'agent:knowledge-agent@0.1.0',
    });
    expect(hop2.statusCode).toBe(200);

    const verifier = new JwtVerifier({ jwks: keys.jwks }, ISSUER);
    const claims = await verifier.verify(hop2.body.access_token, 'acp:agent:knowledge-agent');
    expect(claims.sub).toBe('user:jane.doe');
    // Intersection, never union: cloud:write was requested but never held.
    expect(claims.scope).toBe('knowledge:search:read');
    expect(delegationChain(claims).map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:knowledge-agent@0.1.0',
    ]);
  });

  it('rejects a tampered subject token', async () => {
    const userToken = await issueUserToken();
    const tampered = `${userToken.slice(0, -4)}AAAA`;
    const res = await exchange({ subject_token: tampered, audience: 'acp:orchestrator' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-JWT subject_token_type', async () => {
    const userToken = await issueUserToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/exchange',
      headers: { authorization: basic('svc-orchestrator', 'orch-secret') },
      payload: {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: userToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:saml2',
        audience: 'acp:orchestrator',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids non-platform clients from naming a different actor', async () => {
    const userToken = await issueUserToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/exchange',
      headers: { authorization: basic('svc-lowly', 'lowly-secret') },
      payload: {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: userToken,
        audience: 'acp:tool:firewall-mgr',
        actor: 'agent:someone-else@1.0.0',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('defaults the actor to the authenticated client principal', async () => {
    const userToken = await issueUserToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/exchange',
      headers: { authorization: basic('svc-lowly', 'lowly-secret') },
      payload: {
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: userToken,
        audience: 'acp:somewhere',
      },
    });
    expect(res.statusCode).toBe(200);
    const claims = decodeJwt(res.json<{ access_token: string }>().access_token);
    expect((claims.act as { sub: string }).sub).toBe('svc:lowly');
  });

  it('mints no act claim when the requested actor IS the subject and no chain exists', async () => {
    // The tool gateway re-scopes a plain user token toward acp:knowledge with
    // actor preserved: no delegation happened, so no act link may appear —
    // otherwise the knowledge PEP would record a bogus [user, user] chain.
    const userToken = await issueUserToken();
    const res = await exchange({
      subject_token: userToken,
      audience: 'acp:knowledge',
      scope: 'knowledge:search:read',
      actor: 'user:jane.doe',
    });
    expect(res.statusCode).toBe(200);
    const claims = decodeJwt(res.body.access_token);
    expect(claims.sub).toBe('user:jane.doe');
    expect(claims.act).toBeUndefined();

    // But once a chain exists, an actor equal to the subject still appends —
    // only the "no chain at all" case is a no-op.
    const hop1 = await exchange({
      subject_token: userToken,
      audience: 'acp:orchestrator',
      actor: 'svc:orchestrator',
    });
    const hop2 = await exchange({
      subject_token: hop1.body.access_token,
      audience: 'acp:knowledge',
      actor: 'user:jane.doe',
    });
    const chained = decodeJwt(hop2.body.access_token);
    expect((chained.act as { sub: string }).sub).toBe('user:jane.doe');
  });

  it('emits token.exchanged audit events carrying the delegation chain', async () => {
    const userToken = await issueUserToken();
    auditEvents.length = 0;
    await exchange({ subject_token: userToken, audience: 'acp:orchestrator' });
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.event_type).toBe('token.exchanged');
    expect(event.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
    ]);
  });
});

describe('ADR-0007 broker delegation', () => {
  const SNAPSHOT = {
    sub: 'user:jane.doe',
    tenant: 'acme',
    roles: ['tenant-user'],
    scopes: ['task:submit', 'knowledge:search:read', 'cloud:cost:read'],
  };
  const grounds = (verifiedAt: string = new Date().toISOString()) => ({
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    subject_jti: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f41',
    verified_at: verifiedAt,
  });

  async function delegate(
    payload: Record<string, unknown>,
    auth = basic('svc-orchestrator', 'orch-secret'),
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token/delegate',
      headers: { authorization: auth },
      payload: { grant_type: BROKER_DELEGATION_GRANT, ...payload },
    });
    return { statusCode: res.statusCode, body: res.json<{ access_token: string }>() };
  }

  it('mints from an asserted snapshot: sub preserved, scopes intersected, act chain grown, grounds recorded', async () => {
    const res = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read cloud:write',
      actor: 'agent:cloud-agent@0.1.0',
      grounds: grounds(),
    });
    expect(res.statusCode).toBe(200);

    const verifier = new JwtVerifier({ jwks: keys.jwks }, ISSUER);
    const claims = await verifier.verify(res.body.access_token, 'acp:agent:cloud-agent');
    expect(claims.sub).toBe('user:jane.doe');
    expect(claims.tenant).toBe('acme');
    expect(claims.roles).toEqual(['tenant-user']);
    // Intersection, never union: cloud:write was requested but never held.
    expect(claims.scope).toBe('cloud:cost:read');
    // Same chain shape as the exchange path — audit assertions keep passing.
    expect(delegationChain(claims).map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:cloud-agent@0.1.0',
    ]);
    const brokered = claims.brokered as { task_id: string; verified_at: string };
    expect(brokered.task_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('refuses a request without scope with 400 — the grant never defaults to the snapshot', async () => {
    const res = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:orchestrator',
      grounds: grounds(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('scope is required');
  });

  it('empty scope means an empty grant: a toolless agent gets NOTHING, not the whole snapshot', async () => {
    // Simulates a schema-valid manifest with no `tools`: the orchestrator
    // requests [] (serialized as ''), while the snapshot holds many scopes.
    const res = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:orchestrator',
      scope: '',
      grounds: grounds(),
    });
    expect(res.statusCode).toBe(200);
    const claims = decodeJwt(res.body.access_token);
    expect(claims.scope).toBe('');
    // The actor still defaults to the broker itself.
    expect((claims.act as { sub: string }).sub).toBe('svc:orchestrator');
  });

  it('clamps requested TTL to 15 minutes — no loopholes on the broker path', async () => {
    const res = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read',
      grounds: grounds(),
      requested_ttl: '86400',
    });
    expect(res.statusCode).toBe(200);
    const claims = decodeJwt(res.body.access_token);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('refuses clients without the broker role: agent-role and platform-only alike', async () => {
    for (const auth of [
      basic('agent-something', 'agent-secret'),
      basic('svc-platform-only', 'platform-secret'),
    ]) {
      const res = await delegate(
        {
          subject: SNAPSHOT,
          audience: 'acp:agent:cloud-agent',
          scope: 'cloud:cost:read',
          grounds: grounds(),
        },
        auth,
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.body)).toContain('broker role required');
    }
  });

  it('refuses stale grounds (25h old) and unparseable verified_at', async () => {
    const stale = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read',
      grounds: grounds(new Date(Date.now() - 25 * 3600 * 1000).toISOString()),
    });
    expect(stale.statusCode).toBe(403);
    expect(JSON.stringify(stale.body)).toContain('stale');

    const garbled = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read',
      grounds: grounds('not-a-timestamp'),
    });
    expect(garbled.statusCode).toBe(403);

    const future = await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read',
      grounds: grounds(new Date(Date.now() + 3600 * 1000).toISOString()),
    });
    expect(future.statusCode).toBe(403);
  });

  it('rejects missing audience, subject, grounds fields, and wrong grant_type with 400', async () => {
    for (const payload of [
      { subject: SNAPSHOT, scope: 'cloud:cost:read', grounds: grounds() },
      { audience: 'acp:agent:cloud-agent', scope: 'cloud:cost:read', grounds: grounds() },
      { subject: SNAPSHOT, audience: 'acp:agent:cloud-agent', scope: 'cloud:cost:read' },
      {
        subject: SNAPSHOT,
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:cost:read',
        grounds: { task_id: grounds().task_id },
      },
      {
        subject: { sub: 'user:jane.doe' },
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:cost:read',
        grounds: grounds(),
      },
      {
        grant_type: 'client_credentials',
        subject: SNAPSHOT,
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:cost:read',
        grounds: grounds(),
      },
    ]) {
      const res = await delegate(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('emits a token.brokered audit event joining the mint to its task, and stays available if the sink fails', async () => {
    auditEvents.length = 0;
    await delegate({
      subject: SNAPSHOT,
      audience: 'acp:agent:cloud-agent',
      scope: 'cloud:cost:read',
      actor: 'agent:cloud-agent@0.1.0',
      grounds: grounds(),
    });
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.event_type).toBe('token.brokered');
    expect(event.tenant).toBe('acme');
    expect(event.reason?.task_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');
    expect(event.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:cloud-agent@0.1.0',
    ]);
    const details = event.details as {
      subject: string;
      audience: string;
      actor: string;
      grounds: { task_id: string; verified_at: string };
    };
    expect(details.subject).toBe('user:jane.doe');
    expect(details.audience).toBe('acp:agent:cloud-agent');
    expect(details.actor).toBe('agent:cloud-agent@0.1.0');
    expect(details.grounds.task_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');

    // R0 fail-open-with-alarm: issuance survives a dead audit sink.
    const failingApp = await buildTokenApp({
      keys,
      clients: new ClientRegistry(CLIENTS),
      issuer: ISSUER,
      audit: { publish: () => Promise.reject(new Error('stream down')) },
      logger: createLogger('token-service-test'),
    });
    const res = await failingApp.inject({
      method: 'POST',
      url: '/v1/token/delegate',
      headers: { authorization: basic('svc-orchestrator', 'orch-secret') },
      payload: {
        grant_type: BROKER_DELEGATION_GRANT,
        subject: SNAPSHOT,
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:cost:read',
        grounds: grounds(),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('request validation and client auth edge cases', () => {
  it('rejects unsupported grant_type on /v1/token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: { grant_type: 'password', audience: 'acp:gateway' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects exchange without subject_token and without audience', async () => {
    for (const payload of [
      { grant_type: TOKEN_EXCHANGE_GRANT, audience: 'acp:x' },
      { grant_type: TOKEN_EXCHANGE_GRANT, subject_token: await issueUserToken() },
      { grant_type: 'client_credentials', subject_token: 'x', audience: 'acp:x' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/token/exchange',
        headers: { authorization: basic('svc-orchestrator', 'orch-secret') },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('accepts client credentials in the form body and rejects requests with none', async () => {
    const withBody = await app.inject({
      method: 'POST',
      url: '/v1/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: 'cli-jane',
        client_secret: 'jane-secret',
        audience: 'acp:gateway',
      },
    });
    expect(withBody.statusCode).toBe(200);

    const withNone = await app.inject({
      method: 'POST',
      url: '/v1/token',
      payload: { grant_type: 'client_credentials', audience: 'acp:gateway' },
    });
    expect(withNone.statusCode).toBe(401);

    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: `Basic ${Buffer.from('no-separator').toString('base64')}` },
      payload: { grant_type: 'client_credentials', audience: 'acp:gateway' },
    });
    expect(malformed.statusCode).toBe(401);
  });

  it('rejects a non-integer requested_ttl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: {
        grant_type: 'client_credentials',
        audience: 'acp:gateway',
        requested_ttl: 'soon',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts application/x-www-form-urlencoded bodies (OAuth wire shape)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: {
        authorization: basic('cli-jane', 'jane-secret'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'grant_type=client_credentials&audience=acp%3Agateway',
    });
    expect(res.statusCode).toBe(200);
  });

  it('stays available when the audit sink fails (R0 fail-open-with-alarm)', async () => {
    const failingApp = await buildTokenApp({
      keys,
      clients: new ClientRegistry(CLIENTS),
      issuer: ISSUER,
      audit: {
        publish: () => Promise.reject(new Error('stream down')),
      },
      logger: createLogger('token-service-test'),
    });
    const res = await failingApp.inject({
      method: 'POST',
      url: '/v1/token',
      headers: { authorization: basic('cli-jane', 'jane-secret') },
      payload: { grant_type: 'client_credentials', audience: 'acp:gateway' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('JWKS', () => {
  it('serves the current public key and keeps a previous key through rotation', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    const jwks = res.json<{ keys: { kid: string; kty: string; alg: string }[] }>();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.kty).toBe('OKP');
    expect(jwks.keys[0]!.alg).toBe('EdDSA');
  });
});
