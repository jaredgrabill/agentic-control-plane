import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuditApp, AUDIT_AUDIENCE } from '../src/app.js';
import { handleAuditMessage } from '../src/consumer.js';
import type { AuditQuery, AuditStore } from '../src/store.js';

const ISSUER = 'https://token.test.local';
const logger = createLogger('audit-test');

function validEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f50',
    occurred_at: '2026-07-11T09:00:12Z',
    tenant: 'acme',
    event_type: 'policy.decision',
    actor: {
      principal: 'agent:knowledge-agent@0.1.0',
      delegation_chain: [
        { sub: 'user:jane.doe' },
        { sub: 'svc:orchestrator' },
        { sub: 'agent:knowledge-agent@0.1.0' },
      ],
    },
    action: { name: 'knowledge.search' },
    reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40' },
    ...overrides,
  };
}

class MemoryStore implements AuditStore {
  events = new Map<string, AuditEvent>();
  failNext = false;
  append(event: AuditEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('postgres down'));
    }
    // Idempotent on event_id, like the ON CONFLICT DO NOTHING real store.
    if (!this.events.has(event.event_id)) this.events.set(event.event_id, event);
    return Promise.resolve();
  }
  query(q: AuditQuery): Promise<AuditEvent[]> {
    return Promise.resolve(
      [...this.events.values()].filter(
        (e) =>
          e.tenant === q.tenant &&
          (q.taskId === undefined || e.reason?.task_id === q.taskId) &&
          (q.eventType === undefined || e.event_type === q.eventType),
      ),
    );
  }
}

function makeMsg(payload: unknown): {
  data: Uint8Array;
  subject: string;
  ack: ReturnType<typeof vi.fn>;
  nak: ReturnType<typeof vi.fn>;
  term: ReturnType<typeof vi.fn>;
} {
  return {
    data: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    subject: 'acp.acme.audit.policy.decision',
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  };
}

describe('handleAuditMessage', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('appends valid events and acks', async () => {
    const msg = makeMsg(validEvent());
    await handleAuditMessage(msg, store, logger);
    expect(store.events.size).toBe(1);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it('is idempotent under redelivery (same event_id twice, one record)', async () => {
    await handleAuditMessage(makeMsg(validEvent()), store, logger);
    await handleAuditMessage(makeMsg(validEvent()), store, logger);
    expect(store.events.size).toBe(1);
  });

  it('terminates schema-invalid and unparseable events instead of poisoning the consumer', async () => {
    const invalid = makeMsg({ event_type: 'not.in.vocabulary' });
    await handleAuditMessage(invalid, store, logger);
    expect(invalid.term).toHaveBeenCalled();
    expect(invalid.ack).not.toHaveBeenCalled();

    const garbage = makeMsg('{not json');
    await handleAuditMessage(garbage, store, logger);
    expect(garbage.term).toHaveBeenCalled();
    expect(store.events.size).toBe(0);
  });

  it('NAKs on store failure so the stream redelivers', async () => {
    store.failNext = true;
    const msg = makeMsg(validEvent());
    await handleAuditMessage(msg, store, logger);
    expect(msg.nak).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();

    const retry = makeMsg(validEvent());
    await handleAuditMessage(retry, store, logger);
    expect(retry.ack).toHaveBeenCalled();
    expect(store.events.size).toBe(1);
  });
});

describe('provenance API', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let jwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA');
    key = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
  });

  beforeEach(async () => {
    store = new MemoryStore();
    app = buildAuditApp({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } }, ISSUER),
      store,
      logger,
    });
    await handleAuditMessage(makeMsg(validEvent()), store, logger);
    await handleAuditMessage(
      makeMsg(
        validEvent({
          event_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f51',
          event_type: 'step.completed',
        }),
      ),
      store,
      logger,
    );
  });

  async function makeToken(scope = 'audit:read'): Promise<string> {
    return new SignJWT({ sub: 'user:auditor', tenant: 'acme', roles: ['platform-admin'], scope })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(AUDIT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  it('serves the full delegation chain for a task', async () => {
    const res = await app.inject({
      url: '/v1/events?tenant=acme&task_id=0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: AuditEvent[] }>();
    expect(events).toHaveLength(2);
    expect(events[0]!.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:knowledge-agent@0.1.0',
    ]);
  });

  it('filters by event_type and requires tenant', async () => {
    const filtered = await app.inject({
      url: '/v1/events?tenant=acme&event_type=step.completed',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(filtered.json<{ events: AuditEvent[] }>().events).toHaveLength(1);

    const noTenant = await app.inject({
      url: '/v1/events',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(noTenant.statusCode).toBe(400);
  });

  it('enforces authN and audit:read scope', async () => {
    expect((await app.inject({ url: '/v1/events?tenant=acme' })).statusCode).toBe(401);
    const wrongScope = await app.inject({
      url: '/v1/events?tenant=acme',
      headers: { authorization: `Bearer ${await makeToken('task:submit')}` },
    });
    expect(wrongScope.statusCode).toBe(403);
  });
});
