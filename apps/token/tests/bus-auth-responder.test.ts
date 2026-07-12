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

/**
 * Builds the message the server actually sends: the request sealed to the
 * responder's xkey with the server's ephemeral key advertised in the header.
 * The responder now REFUSES any request lacking that header (a plaintext path
 * would be a token-minting oracle), so every legitimate case seals.
 */
function sealedMsg(authToken: string | undefined): FakeMsg {
  const plain = new TextEncoder().encode(requestJwt(authToken));
  const sealed = serverXkey.seal(plain, responderXkey.getPublicKey());
  return new FakeMsg(sealed, {
    get: (k) => (k === 'Nats-Server-Xkey' ? serverXkey.getPublicKey() : undefined),
  });
}

/** Opens a sealed response and returns its nats claim. */
function openResponse(msg: FakeMsg): { jwt?: string; error?: string } {
  const opened = serverXkey.open(msg.respondedWith!, responderXkey.getPublicKey());
  const decoded = Buffer.from(
    new TextDecoder().decode(opened).split('.')[1] ?? '',
    'base64url',
  ).toString('utf8');
  return (JSON.parse(decoded) as { nats: { jwt?: string; error?: string } }).nats;
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

/**
 * Deterministically waits until the responder has replied, polling the fake
 * message rather than racing a fixed timeout against the async crypto chain
 * (verify + xkey.open + seal). Resolves as soon as a response lands, or after
 * ~2s so a genuinely stuck responder still fails the assertion rather than
 * hanging the suite.
 */
async function waitForResponse(msg: FakeMsg): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (msg.respondedWith !== undefined) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A short bounded settle for the negative cases: the responder is expected to
 * DROP the request without replying, so we give its async chain time to run to
 * completion and then assert nothing was responded.
 */
const settle = () => new Promise((r) => setTimeout(r, 100));

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
  it('mints and audits an allow for a valid (sealed) token', async () => {
    const msg = sealedMsg(await busToken());
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await waitForResponse(msg);
    expect(msg.respondedWith).toBeDefined();

    // The response carries a user JWT.
    const nats = openResponse(msg);
    expect(nats.jwt).toBeDefined();
    expect(nats.error).toBeUndefined();

    expect(audited).toHaveLength(1);
    expect(audited[0]!.event_type).toBe('bus.auth');
    expect(audited[0]!.actor.principal).toBe('agent:cloud-agent@0.1.0');
    expect((audited[0]!.details as { decision: string }).decision).toBe('allow');
    await responder.stop();
  });

  it('audits a deny for a verified-but-refused token', async () => {
    const msg = sealedMsg(await busToken({ roles: ['tenant-user'] }));
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await waitForResponse(msg);
    const nats = openResponse(msg);
    expect(nats.error).toBeDefined();
    expect(audited).toHaveLength(1);
    expect((audited[0]!.details as { decision: string }).decision).toBe('deny');
    await responder.stop();
  });

  it('responds but does NOT audit an unverified (credential-less) connect', async () => {
    const msg = sealedMsg(undefined);
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await waitForResponse(msg);
    expect(msg.respondedWith).toBeDefined();
    expect(audited).toHaveLength(0);
    await responder.stop();
  });

  it('drops a header-less (plaintext) request without responding or auditing', async () => {
    // No Nats-Server-Xkey header: the responder runs with xkey configured, so
    // this could only be forged plaintext from a co-account publisher.
    const msg = new FakeMsg(new TextEncoder().encode(requestJwt(await busToken())));
    const audited: AuditEvent[] = [];
    const responder = startBusAuthResponder(makeDeps([msg], audited));
    await settle();
    expect(msg.respondedWith).toBeUndefined();
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
    await waitForResponse(msg);
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
    await settle();
    expect(msg.respondedWith).toBeUndefined();
    expect(audited).toHaveLength(0);
    await responder.stop();
  });
});
