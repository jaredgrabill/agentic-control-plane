import { SignJWT, decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { BusAuthCore } from '../src/bus-auth/core.js';
import { accountFromSeed } from '../src/bus-auth/nkeys.js';
import { decodeAuthRequest, encodeAuthResponse } from '../src/bus-auth/nats-jwt.js';
import { loadKeyStore, type KeyStore } from '../src/keys.js';

const ISSUER = 'https://token.test.local';
// Committed dev seed (also in run-platform.mjs / nats-server.conf).
const ISSUER_SEED = 'SAAJEKZZJVRSXKW4IF7JU553MIIBJ33TBQTEREDBX6PUDOYXCQ4LFBBV24';
const USER_NKEY = 'UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';

let keys: KeyStore;
let issuerPublic: string;
const account = accountFromSeed(ISSUER_SEED);

// Toggleable kill-switch stub.
const ks = { fleet: false, agents: new Set<string>(), principals: new Set<string>() };
const killSwitch = {
  fleetHalt: () => (ks.fleet ? { active: true } : undefined),
  agentSuspension: (id: string) => (ks.agents.has(id) ? { active: true } : undefined),
  principalDenied: (sub: string) => (ks.principals.has(sub) ? { active: true } : undefined),
};

let core: BusAuthCore;

beforeAll(async () => {
  keys = await loadKeyStore({ privateKeyPem: undefined, previousPublicKeyPem: undefined });
  issuerPublic = account.getPublicKey();
  core = new BusAuthCore(keys, ISSUER, {
    issuerPublic,
    sign: (data) => account.sign(data),
    tenantAccounts: { acme: 'TENANT_ACME' },
    agentSvcSubjects: ['acp.platform.svc.knowledge.>'],
    killSwitch,
  });
});

function reset() {
  ks.fleet = false;
  ks.agents.clear();
  ks.principals.clear();
}

async function busToken(
  overrides: Record<string, unknown> = {},
  audience = 'acp:bus',
  expiration: string | number = '10m',
): Promise<string> {
  return new SignJWT({
    sub: 'agent:cloud-agent@0.1.0',
    tenant: 'acme',
    roles: ['agent'],
    scope: '',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.current.kid })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(keys.current.privateKey);
}

describe('BusAuthCore mint (happy path)', () => {
  it('mints a user JWT with the exact account, exp, and permission template', async () => {
    reset();
    const token = await busToken();
    const platformExp = decodeJwt(token).exp;
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok, JSON.stringify(decision)).toBe(true);
    if (!decision.ok) return;

    expect(decision.account).toBe('TENANT_ACME');
    expect(decision.principal).toBe('agent:cloud-agent@0.1.0');
    expect(decision.tenant).toBe('acme');
    expect(decision.agentId).toBe('cloud-agent');

    const uc = decodeJwt(decision.userJwt);
    expect(uc.iss).toBe(issuerPublic);
    expect(uc.sub).toBe(USER_NKEY);
    expect(uc.aud).toBe('TENANT_ACME');
    expect(uc.name).toBe('agent:cloud-agent@0.1.0');
    // The bus identity dies with its platform token.
    expect(uc.exp).toBe(platformExp);
    const nats = uc.nats as {
      pub: { allow: string[] };
      sub: { allow: string[] };
      type: string;
      version: number;
    };
    expect(nats.type).toBe('user');
    expect(nats.version).toBe(2);
    expect(nats.pub.allow).toEqual([
      'acp.acme.audit.>',
      'acp.acme.telemetry.>',
      'acp.platform.svc.knowledge.>',
      '_INBOX.>',
    ]);
    expect(nats.sub.allow).toEqual([
      'acp.acme.agent.cloud-agent.>',
      'acp.platform.registry.>',
      'acp.platform.control.>',
      '_INBOX.>',
    ]);
  });
});

describe('BusAuthCore deny matrix (fail closed)', () => {
  it('refuses a credential-less connect', async () => {
    reset();
    const decision = await core.evaluate({ authToken: undefined, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.principal).toBeUndefined(); // unverified → not audited
  });

  it('refuses the wrong audience (cross-audience replay is dead)', async () => {
    reset();
    const token = await busToken({}, 'acp:gateway');
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.principal).toBeUndefined();
  });

  it('refuses an expired token', async () => {
    reset();
    const token = await busToken({}, 'acp:bus', Math.floor(Date.now() / 1000) - 60);
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
  });

  it('refuses a tampered signature', async () => {
    reset();
    const token = await busToken();
    const tampered = `${token.slice(0, -4)}AAAA`;
    const decision = await core.evaluate({ authToken: tampered, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
  });

  it('refuses a non-agent role (verified, so audited)', async () => {
    reset();
    const token = await busToken({ roles: ['tenant-user'] });
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.principal).toBe('agent:cloud-agent@0.1.0');
      expect(decision.tenant).toBe('acme');
    }
  });

  it('refuses a malformed (non-versioned) agent sub', async () => {
    reset();
    const token = await busToken({ sub: 'agent:cloud-agent' }); // no @version
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
  });

  it('refuses an unknown tenant', async () => {
    reset();
    const token = await busToken({ tenant: 'globex' });
    const decision = await core.evaluate({ authToken: token, userNkey: USER_NKEY });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error).toContain('globex');
  });

  it('refuses a suspended agent, a denylisted principal, and a halted fleet', async () => {
    reset();
    ks.agents.add('cloud-agent');
    expect((await core.evaluate({ authToken: await busToken(), userNkey: USER_NKEY })).ok).toBe(
      false,
    );

    reset();
    ks.principals.add('agent:cloud-agent@0.1.0');
    expect((await core.evaluate({ authToken: await busToken(), userNkey: USER_NKEY })).ok).toBe(
      false,
    );

    reset();
    ks.fleet = true;
    const halted = await core.evaluate({ authToken: await busToken(), userNkey: USER_NKEY });
    expect(halted.ok).toBe(false);
    if (!halted.ok) expect(halted.error).toContain('fleet halt');
  });
});

describe('nats-jwt response + request encoding', () => {
  it('wraps the user JWT in an authorization_response with the right shape', () => {
    const response = encodeAuthResponse({
      issuerPublic,
      userNkey: USER_NKEY,
      serverId: 'NSERVERID',
      sign: (data) => account.sign(data),
      userJwt: 'the.user.jwt',
    });
    const parts = response.split('.');
    expect(parts).toHaveLength(3);
    const claims = decodeJwt(response);
    expect(claims.iss).toBe(issuerPublic);
    expect(claims.sub).toBe(USER_NKEY);
    expect(claims.aud).toBe('NSERVERID');
    const nats = claims.nats as { jwt?: string; error?: string; type: string; version: number };
    expect(nats.type).toBe('authorization_response');
    expect(nats.version).toBe(2);
    expect(nats.jwt).toBe('the.user.jwt');
    expect(nats.error).toBeUndefined();
  });

  it('carries an error instead of a jwt on refusal', () => {
    const response = encodeAuthResponse({
      issuerPublic,
      userNkey: USER_NKEY,
      serverId: 'NSERVERID',
      sign: (data) => account.sign(data),
      error: 'nope',
    });
    const nats = decodeJwt(response).nats as { jwt?: string; error?: string };
    expect(nats.error).toBe('nope');
    expect(nats.jwt).toBeUndefined();
  });

  it('decodes an authorization_request, extracting user_nkey, server_id, and auth_token', () => {
    const claims = {
      nats: {
        user_nkey: USER_NKEY,
        server_id: { id: 'NSERVERID', name: 'acp-dev-nats' },
        connect_opts: { auth_token: 'the-platform-jwt' },
        type: 'authorization_request',
        version: 2,
      },
    };
    const middle = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const decoded = decodeAuthRequest(`header.${middle}.sig`);
    expect(decoded.userNkey).toBe(USER_NKEY);
    expect(decoded.serverId).toBe('NSERVERID');
    expect(decoded.authToken).toBe('the-platform-jwt');
  });

  it('rejects a malformed request JWT', () => {
    expect(() => decodeAuthRequest('only.two')).toThrow(/3 segments/);
  });
});
