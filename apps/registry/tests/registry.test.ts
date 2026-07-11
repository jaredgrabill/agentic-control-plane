import type {
  AgentCard,
  AgentManifest,
  AuditEvent,
  Capability,
  LifecycleState,
} from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildRegistryApp, REGISTRY_AUDIENCE } from '../src/app.js';
import { stableStringify, verifyCard } from '../src/signing.js';
import type { AgentFilter, RegistryStore } from '../src/store.js';

const ISSUER = 'https://token.test.local';

class MemoryStore implements RegistryStore {
  readonly cards = new Map<string, AgentCard>();
  put(card: AgentCard): Promise<void> {
    this.cards.set(card.manifest.id, card);
    return Promise.resolve();
  }
  get(agentId: string): Promise<AgentCard | undefined> {
    return Promise.resolve(this.cards.get(agentId));
  }
  list(filter: AgentFilter): Promise<AgentCard[]> {
    return Promise.resolve(
      [...this.cards.values()].filter(
        (c) =>
          (filter.state === undefined || c.lifecycle_state === filter.state) &&
          (filter.capability === undefined ||
            c.manifest.capabilities.some((cap) => cap.name === filter.capability)),
      ),
    );
  }
}

let app: FastifyInstance;
let store: MemoryStore;
let tokenKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let tokenJwk: JWK;
let registryJwks: JSONWebKeySet;

const announcements: { verb: string; card: AgentCard }[] = [];
const suspensions: { agentId: string; suspended: boolean; reason: string }[] = [];
const auditEvents: AuditEvent[] = [];

beforeAll(async () => {
  const tokenPair = await generateKeyPair('EdDSA');
  tokenKey = tokenPair.privateKey;
  tokenJwk = await exportJWK(tokenPair.publicKey);

  const signPair = await generateKeyPair('EdDSA', { extractable: true });
  const signJwk = await exportJWK(signPair.publicKey);
  const kid = await calculateJwkThumbprint(signJwk);
  registryJwks = { keys: [{ ...signJwk, kid, alg: 'EdDSA' }] };

  store = new MemoryStore();
  app = buildRegistryApp({
    verifier: new JwtVerifier({ jwks: { keys: [{ ...tokenJwk, alg: 'EdDSA' }] } }, ISSUER),
    store,
    signingKey: { kid, privateKey: signPair.privateKey },
    jwks: registryJwks,
    announcer: {
      announce: (verb, card) => {
        announcements.push({ verb, card });
        return Promise.resolve();
      },
      setSuspended: (agentId, suspended, reason) => {
        suspensions.push({ agentId, suspended, reason });
        return Promise.resolve();
      },
    },
    audit: {
      publish: (e) => {
        auditEvents.push(e);
        return Promise.resolve();
      },
    },
    logger: createLogger('registry-test'),
  });
});

beforeEach(() => {
  store.cards.clear();
  announcements.length = 0;
  suspensions.length = 0;
  auditEvents.length = 0;
});

async function makeToken(scope: string): Promise<string> {
  return new SignJWT({
    sub: 'svc:agent-ci',
    tenant: 'platform',
    roles: ['platform'],
    scope,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(REGISTRY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(tokenKey);
}

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'knowledge-agent',
    name: 'Knowledge & Policy Agent',
    owner: 'team-platform',
    description: 'Cited answers over the governed corpus.',
    capabilities: [
      {
        name: 'knowledge.search',
        description: 'Hybrid search.',
        risk: 'R0',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        examples: [{ input: {} }, { input: {} }, { input: {} }],
      },
    ],
    ...overrides,
  };
}

async function register(body: unknown, scope = 'registry:write') {
  return app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { authorization: `Bearer ${await makeToken(scope)}` },
    payload: body as Record<string, unknown>,
  });
}

async function transition(agentId: string, state: LifecycleState, reason?: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/state`,
    headers: { authorization: `Bearer ${await makeToken('registry:admin')}` },
    payload: { state, ...(reason === undefined ? {} : { reason }) },
  });
}

describe('registration', () => {
  it('accepts a valid manifest and returns a signed, verifiable card', async () => {
    const res = await register({ manifest: manifest(), version: '0.1.0' });
    expect(res.statusCode).toBe(201);
    const card = res.json<AgentCard>();
    expect(card.lifecycle_state).toBe('registered');
    expect(await verifyCard(card, registryJwks)).toBe(true);
    expect(announcements).toEqual([{ verb: 'registered', card }]);
    expect(auditEvents.map((e) => e.event_type)).toEqual(['agent.registered']);
  });

  it('detects card tampering after signature', async () => {
    const res = await register({ manifest: manifest(), version: '0.1.0' });
    const card = res.json<AgentCard>();
    const tampered: AgentCard = {
      ...card,
      manifest: { ...card.manifest, owner: 'team-evil' },
    };
    expect(await verifyCard(tampered, registryJwks)).toBe(false);
  });

  it('rejects schema-invalid manifests with the violation named', async () => {
    const res = await register({ manifest: { id: 'x' }, version: '0.1.0' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('agent-manifest');
  });

  it('rejects R2 capabilities without a compensator, accepts irreversible:true', async () => {
    const r2: Capability = {
      name: 'change.submit',
      description: 'Submit a change record.',
      risk: 'R2',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      examples: [{ input: {} }, { input: {} }, { input: {} }],
    };
    const rejected = await register({
      manifest: manifest({ capabilities: [r2] }),
      version: '0.1.0',
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { message: string } }>().error.message).toContain('compensator');

    const withCompensator = await register({
      manifest: manifest({ capabilities: [{ ...r2, compensator: 'change.withdraw' }] }),
      version: '0.1.0',
    });
    expect(withCompensator.statusCode).toBe(201);

    const irreversible = await register({
      manifest: manifest({ capabilities: [{ ...r2, irreversible: true }] }),
      version: '0.1.0',
    });
    expect(irreversible.statusCode).toBe(201);
  });

  it('rejects duplicate capability names and a missing version', async () => {
    const cap = manifest().capabilities[0];
    const dup = await register({
      manifest: manifest({ capabilities: [cap, cap] }),
      version: '0.1.0',
    });
    expect(dup.statusCode).toBe(400);

    const noVersion = await register({ manifest: manifest() });
    expect(noVersion.statusCode).toBe(400);
  });

  it('enforces authN and the registry:write scope', async () => {
    const noToken = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { manifest: manifest(), version: '0.1.0' },
    });
    expect(noToken.statusCode).toBe(401);

    const wrongScope = await register({ manifest: manifest(), version: '0.1.0' }, 'registry:read');
    expect(wrongScope.statusCode).toBe(403);
  });
});

describe('discovery', () => {
  it('gets by id and filters by capability and state', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });

    const byId = await app.inject({
      url: '/v1/agents/knowledge-agent',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(byId.statusCode).toBe(200);

    const hit = await app.inject({
      url: '/v1/agents?capability=knowledge.search&state=registered',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(hit.json<{ agents: AgentCard[] }>().agents).toHaveLength(1);

    const miss = await app.inject({
      url: '/v1/agents?capability=netsec.rule_apply',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(miss.json<{ agents: AgentCard[] }>().agents).toHaveLength(0);

    const unknown = await app.inject({
      url: '/v1/agents/nobody',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('lifecycle transitions', () => {
  beforeEach(async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    announcements.length = 0;
    auditEvents.length = 0;
  });

  it('promotes registered → active and announces the update', async () => {
    const res = await transition('knowledge-agent', 'active');
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentCard>().lifecycle_state).toBe('active');
    expect(announcements.map((a) => a.verb)).toEqual(['updated']);
    expect(auditEvents.map((e) => e.event_type)).toEqual(['agent.lifecycle_changed']);
    expect(suspensions).toHaveLength(0);
  });

  it('suspends an active agent: kill-switch flag first, then announcement and audit', async () => {
    await transition('knowledge-agent', 'active');
    suspensions.length = 0;
    auditEvents.length = 0;

    const res = await transition('knowledge-agent', 'suspended', 'bad citations in prod');
    expect(res.statusCode).toBe(200);
    expect(suspensions).toEqual([
      { agentId: 'knowledge-agent', suspended: true, reason: 'bad citations in prod' },
    ]);
    expect(auditEvents.map((e) => e.event_type)).toEqual([
      'agent.lifecycle_changed',
      'killswitch.activated',
    ]);
  });

  it('reinstates a suspended agent and clears the flag', async () => {
    await transition('knowledge-agent', 'active');
    await transition('knowledge-agent', 'suspended', 'drill');
    suspensions.length = 0;
    auditEvents.length = 0;

    const res = await transition('knowledge-agent', 'active', 'drill complete');
    expect(res.statusCode).toBe(200);
    expect(suspensions).toEqual([
      { agentId: 'knowledge-agent', suspended: false, reason: 'drill complete' },
    ]);
    expect(auditEvents.map((e) => e.event_type)).toEqual([
      'agent.lifecycle_changed',
      'killswitch.cleared',
    ]);
  });

  it('rejects transitions outside the v0 vocabulary', async () => {
    const res = await transition('knowledge-agent', 'suspended');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('registered');

    const canary = await transition('knowledge-agent', 'canary');
    expect(canary.statusCode).toBe(409);
  });

  it('404s on unknown agents', async () => {
    const res = await transition('ghost-agent', 'active');
    expect(res.statusCode).toBe(404);
  });
});

describe('edge cases', () => {
  it('lists all agents when no filter is given', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    const res = await app.inject({
      url: '/v1/agents',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(res.json<{ agents: AgentCard[] }>().agents).toHaveLength(1);
  });

  it('verifyCard returns false for garbage signatures instead of throwing', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    const card = store.cards.get('knowledge-agent')!;
    expect(await verifyCard({ ...card, card_signature: 'not-a-jws' }, registryJwks)).toBe(false);
  });

  it('rejects a registration with no manifest at all', async () => {
    const res = await register({ version: '0.1.0' });
    expect(res.statusCode).toBe(400);
  });
});

describe('stableStringify', () => {
  it('is insertion-order independent and drops undefined members', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
    expect(stableStringify({ a: 1, gone: undefined })).toBe('{"a":1}');
  });
});
