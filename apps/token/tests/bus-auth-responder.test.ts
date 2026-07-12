import type { AuditEvent } from '@acp/protocol';
import { createLogger } from '@acp/service-kit';
import type { Msg, NatsConnection, Subscription } from 'nats';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { BusAuthCore } from '../src/bus-auth/core.js';
import { accountFromSeed, curveFromSeed } from '../src/bus-auth/nkeys.js';
import { startBusAuthResponder } from '../src/bus-auth/responder.js';
import { loadKeyStore, type KeyStore } from '../src/keys.js';

const ISSUER = 'https://token.test.local';
const ISSUER_SEED = 'SAAJEKZZJVRSXKW4IF7JU553MIIBJ33TBQTEREDBX6PUDOYXCQ4LFBBV24';
const XKEY_SEED = 'SXAK5Q7G7ZME7KLXT6BL6IGR7LCKOOBUSNTZCYEACXZP2WIWSWPARSQYKY';
// A distinct curve seed standing in for the server's ephemeral xkey.
const SERVER_XKEY_SEED = 'SXACOR7ZCF7B2YRKSZEIAAOSG3KOVGBLWXBYJO2AOFIPCXKZVSBQSKVW54';
const USER_NKEY = 'UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';

const account = accountFromSeed(ISSUER_SEED);
const responderXkey = curveFromSeed(XKEY_SEED);
const serverXkey = curveFromSeed(SERVER_XKEY_SEED);
let keys: KeyStore;
let core: BusAuthCore;

beforeAll(async () => {
  keys = await loadKeyStore({ privateKeyPem: undefined, previousPublicKeyPem: undefined });
  core = new BusAuthCore(keys, ISSUER, {
    issuerPublic: account.getPublicKey(),
    sign: (data) => account.sign(data),
    tenantAccounts: { acme: 'TENANT_ACME' },
    agentSvcSubjects: ['acp.platform.svc.knowledge.>'],
  });
});

async function busToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: 'agent:cloud-agent@0.1.0',
    tenant: 'acme',
    roles: ['agent'],
    scope: '',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.current.kid })
    .setIssuer(ISSUER)
    .setAudience('acp:bus')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(keys.current.privateKey);
}

/** Builds an unsigned-but-decodable authorization_request JWT (sig unchecked). */
function requestJwt(authToken: string | undefined): string {
  const claims = {
    nats: {
      user_nkey: USER_NKEY,
      server_id: { id: 'NSERVERID' },
      connect_opts: authToken === undefined ? {} : { auth_token: authToken },
      type: 'authorization_request',
      version: 2,
    },
  };
  const middle = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `header.${middle}.sig`;
}

class FakeMsg {
  respondedWith: Uint8Array | undefined;
  constructor(
    public data: Uint8Array,
    public headers?: { get: (k: string) => string | undefined },
  ) {}
  respond(data: Uint8Array): boolean {
    this.respondedWith = data;
    return true;
  }
}

/** A fake NatsConnection whose subscribe replays a scripted set of messages. */
function fakeNc(msgs: FakeMsg[]): NatsConnection {
  async function* iterate(): AsyncGenerator<Msg> {
    for (const m of msgs) yield m as unknown as Msg;
    // Keep the async iterator open briefly so start()'s loop stays alive
    // until we assert; the drain() in stop() ends it.
    await new Promise((r) => setTimeout(r, 20));
  }
  const sub = Object.assign(iterate(), {
    drain: () => Promise.resolve(),
  }) as unknown as Subscription;
  return { subscribe: () => sub } as unknown as NatsConnection;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

function makeDeps(msgs: FakeMsg[], audited: AuditEvent[]) {
  return {
    nc: fakeNc(msgs),
    core,
    xkey: responderXkey,
    issuerPublic: account.getPublicKey(),
    sign: (data: Uint8Array) => account.sign(data),
    audit: {
      publish: (e: AuditEvent) => {
        audited.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('bus-auth-responder-test'),
  };
}

describe('bus auth responder', () => {
  it('mints and audits an allow for a valid token (unencrypted)', async () => {
    const msg = new FakeMsg(new TextEncoder().encode(requestJwt(await busToken())));
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await flush();
    expect(msg.respondedWith).toBeDefined();

    // The response carries a user JWT.
    const decoded = Buffer.from(
      new TextDecoder().decode(msg.respondedWith).split('.')[1] ?? '',
      'base64url',
    ).toString('utf8');
    const nats = (JSON.parse(decoded) as { nats: { jwt?: string; error?: string } }).nats;
    expect(nats.jwt).toBeDefined();
    expect(nats.error).toBeUndefined();

    expect(audited).toHaveLength(1);
    expect(audited[0]!.event_type).toBe('bus.auth');
    expect(audited[0]!.actor.principal).toBe('agent:cloud-agent@0.1.0');
    expect((audited[0]!.details as { decision: string }).decision).toBe('allow');
    await responder.stop();
  });

  it('audits a deny for a verified-but-refused token', async () => {
    const msg = new FakeMsg(
      new TextEncoder().encode(requestJwt(await busToken({ roles: ['tenant-user'] }))),
    );
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await flush();
    const decoded = Buffer.from(
      new TextDecoder().decode(msg.respondedWith).split('.')[1] ?? '',
      'base64url',
    ).toString('utf8');
    const nats = (JSON.parse(decoded) as { nats: { error?: string } }).nats;
    expect(nats.error).toBeDefined();
    expect(audited).toHaveLength(1);
    expect((audited[0]!.details as { decision: string }).decision).toBe('deny');
    await responder.stop();
  });

  it('responds but does NOT audit an unverified (credential-less) connect', async () => {
    const msg = new FakeMsg(new TextEncoder().encode(requestJwt(undefined)));
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await flush();
    expect(msg.respondedWith).toBeDefined();
    expect(audited).toHaveLength(0);
    await responder.stop();
  });

  it('decrypts a sealed request and seals the response (xkey path)', async () => {
    // Simulate the server: an ephemeral curve key seals the request to the
    // responder's xkey public and advertises its own public in the header.
    const responderPub = responderXkey.getPublicKey();
    const serverPub = serverXkey.getPublicKey();
    const plain = new TextEncoder().encode(requestJwt(await busToken()));
    const sealed = serverXkey.seal(plain, responderPub);
    const msg = new FakeMsg(sealed, {
      get: (k) => (k === 'Nats-Server-Xkey' ? serverPub : undefined),
    });
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await flush();
    const responded = msg.respondedWith;
    if (responded === undefined) throw new Error('responder did not reply');
    // The response is sealed to the server: open it with the server key.
    const opened = serverXkey.open(responded, responderPub);
    const decoded = Buffer.from(
      new TextDecoder().decode(opened).split('.')[1] ?? '',
      'base64url',
    ).toString('utf8');
    expect((JSON.parse(decoded) as { nats: { jwt?: string } }).nats.jwt).toBeDefined();
    expect(audited).toHaveLength(1);
    await responder.stop();
  });

  it('drops an undecryptable request without responding', async () => {
    const msg = new FakeMsg(new TextEncoder().encode('garbage-not-sealed'), {
      get: (k) => (k === 'Nats-Server-Xkey' ? serverXkey.getPublicKey() : undefined),
    });
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await flush();
    expect(msg.respondedWith).toBeUndefined();
    expect(audited).toHaveLength(0);
    await responder.stop();
  });
});
