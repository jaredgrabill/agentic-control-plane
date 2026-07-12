import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditApp,
  AUDIT_AUDIENCE,
  RETENTION_FLOOR_DAYS,
  resolveRetentionHotDays,
} from '../src/app.js';
import { handleAuditMessage } from '../src/consumer.js';
import {
  CHAIN_ALGORITHM,
  GENESIS_PREV_HASH,
  computeRecordHash,
  type ChainRow,
} from '../src/chain.js';
import type { AuditQuery, AuditStore, ChainHead } from '../src/store.js';

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

/**
 * Chain-aware in-memory store: mirrors PgAuditStore's per-tenant hashing so the
 * /v1/verify endpoint and tamper detection are testable at the app level without
 * Postgres (the DB trigger enforcement is exercised by the E2E tamper drill).
 */
class MemoryStore implements AuditStore {
  events = new Map<string, AuditEvent>();
  chains = new Map<string, ChainRow[]>();
  failNext = false;
  append(event: AuditEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('postgres down'));
    }
    // Idempotent on event_id (like ON CONFLICT DO NOTHING) — no double-chain.
    if (this.events.has(event.event_id)) return Promise.resolve();
    this.events.set(event.event_id, event);
    const rows = this.chains.get(event.tenant) ?? [];
    const prev = rows.at(-1);
    const chainSeq = (prev?.chain_seq ?? 0) + 1;
    const prevHash = prev?.record_hash ?? GENESIS_PREV_HASH;
    const recordHash = computeRecordHash({ tenant: event.tenant, chainSeq, prevHash, event });
    rows.push({ chain_seq: chainSeq, prev_hash: prevHash, record_hash: recordHash, event });
    this.chains.set(event.tenant, rows);
    return Promise.resolve();
  }
  query(q: AuditQuery): Promise<AuditEvent[]> {
    return Promise.resolve(
      [...this.events.values()].filter(
        (e) =>
          e.tenant === q.tenant &&
          (q.taskId === undefined || e.reason?.task_id === q.taskId) &&
          (q.eventType === undefined || e.event_type === q.eventType) &&
          (q.since === undefined || Date.parse(e.occurred_at) >= Date.parse(q.since)),
      ),
    );
  }
  chainPage(tenant: string, fromSeq: number, limit: number): Promise<ChainRow[]> {
    const rows = (this.chains.get(tenant) ?? []).filter((r) => r.chain_seq >= fromSeq);
    return Promise.resolve(rows.slice(0, limit));
  }
  chainHead(tenant: string): Promise<ChainHead | undefined> {
    const h = (this.chains.get(tenant) ?? []).at(-1);
    return Promise.resolve(h && { chain_seq: h.chain_seq, record_hash: h.record_hash });
  }
  chainByTask(tenant: string, taskId: string, limit: number): Promise<ChainRow[]> {
    const rows = (this.chains.get(tenant) ?? []).filter((r) => r.event.reason?.task_id === taskId);
    return Promise.resolve(rows.slice(0, limit));
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

  it('filters by since (occurred_at >=) and rejects a non-ISO since', async () => {
    // The two seeded events are both at 2026-07-11T09:00:12Z. A since strictly
    // after them returns none; a since at/before returns both.
    const after = await app.inject({
      url: '/v1/events?tenant=acme&since=2026-07-11T10:00:00Z',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(after.json<{ events: AuditEvent[] }>().events).toHaveLength(0);

    const atOrBefore = await app.inject({
      url: '/v1/events?tenant=acme&since=2026-07-11T09:00:12Z',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(atOrBefore.json<{ events: AuditEvent[] }>().events).toHaveLength(2);

    const bad = await app.inject({
      url: '/v1/events?tenant=acme&since=not-a-date',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('enforces authN and audit:read scope', async () => {
    expect((await app.inject({ url: '/v1/events?tenant=acme' })).statusCode).toBe(401);
    const wrongScope = await app.inject({
      url: '/v1/events?tenant=acme',
      headers: { authorization: `Bearer ${await makeToken('task:submit')}` },
    });
    expect(wrongScope.statusCode).toBe(403);
  });

  it('binds a non-platform caller to its own tenant on every read route (403 cross-tenant)', async () => {
    // A tenant-scoped token (no platform-family role, non-svc principal) may
    // query its own tenant but not name another; platform-admin (makeToken)
    // stays exempt — the cross-tenant 404 test below proves that.
    const tenantToken = await new SignJWT({
      sub: 'user:jane.doe',
      tenant: 'acme',
      roles: ['tenant-user'],
      scope: 'audit:read',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(AUDIT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    const get = (url: string) =>
      app.inject({ url, headers: { authorization: `Bearer ${tenantToken}` } });

    expect((await get('/v1/events?tenant=acme')).statusCode).toBe(200);
    expect((await get('/v1/events?tenant=other-tenant')).statusCode).toBe(403);
    expect((await get('/v1/verify?tenant=acme')).statusCode).toBe(200);
    expect((await get('/v1/verify?tenant=other-tenant')).statusCode).toBe(403);
    const recon = '/v1/tasks/0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40/reconstruction';
    expect((await get(`${recon}?tenant=acme`)).statusCode).toBe(200);
    expect((await get(`${recon}?tenant=other-tenant`)).statusCode).toBe(403);
  });

  async function verify(query: string, scope = 'audit:read') {
    return app.inject({
      url: `/v1/verify?${query}`,
      headers: { authorization: `Bearer ${await makeToken(scope)}` },
    });
  }

  it('verifies a clean chain: verified true, head reported, records counted', async () => {
    const res = await verify('tenant=acme');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      verified: boolean;
      algorithm: string;
      records_checked: number;
      head: { chain_seq: number; record_hash: string };
    }>();
    expect(body.verified).toBe(true);
    expect(body.algorithm).toBe(CHAIN_ALGORITHM);
    expect(body.records_checked).toBe(2);
    expect(body.head.chain_seq).toBe(2);
    expect(body.head.record_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('detects a mutated record as hash_mismatch at its seq', async () => {
    // Tamper directly with the stored chain row (simulating a DB mutation that
    // bypassed the append-only trigger), leaving record_hash untouched.
    const rows = store.chains.get('acme')!;
    rows[1]!.event = { ...rows[1]!.event, event_type: 'model.invoked' };
    const res = await verify('tenant=acme');
    const body = res.json<{ verified: boolean; failure: { kind: string; chain_seq: number } }>();
    expect(body.verified).toBe(false);
    expect(body.failure.kind).toBe('hash_mismatch');
    expect(body.failure.chain_seq).toBe(2);
  });

  it('detects a broken link when a record hash is rewritten (link_mismatch)', async () => {
    // Rewrite row 1's record_hash so row 2's prev_hash no longer links.
    const rows = store.chains.get('acme')!;
    rows[0]!.record_hash = `sha256:${'a'.repeat(64)}`;
    const res = await verify('tenant=acme');
    const body = res.json<{ verified: boolean; failure: { kind: string; chain_seq: number } }>();
    expect(body.verified).toBe(false);
    // Row 1 recompute now mismatches its rewritten hash first → hash_mismatch@1.
    expect(body.failure.chain_seq).toBe(1);
    expect(body.failure.kind).toBe('hash_mismatch');
  });

  it('verifies a pruned suffix against a supplied anchor, and 400s without one', async () => {
    const rows = store.chains.get('acme')!;
    // Verify from seq 2 using seq 1's record_hash as the anchor → passes.
    const ok = await verify(`tenant=acme&from_seq=2&anchor_prev_hash=${rows[0]!.record_hash}`);
    expect(ok.json<{ verified: boolean; records_checked: number }>()).toMatchObject({
      verified: true,
      records_checked: 1,
    });
    // A wrong anchor → link_mismatch at seq 2.
    const bad = await verify(`tenant=acme&from_seq=2&anchor_prev_hash=sha256:${'b'.repeat(64)}`);
    expect(bad.json<{ verified: boolean; failure: { kind: string } }>().failure.kind).toBe(
      'link_mismatch',
    );
    // from_seq>1 without an anchor is a 400 (cannot verify a suffix blind).
    expect((await verify('tenant=acme&from_seq=2')).statusCode).toBe(400);
  });

  it('requires a tenant and the audit:read scope', async () => {
    expect((await verify('')).statusCode).toBe(400);
    expect((await verify('tenant=acme', 'task:submit')).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/verify?tenant=acme' })).statusCode).toBe(401);
  });

  const RECON_TASK = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40';
  async function reconstruct(taskId: string, query: string, scope = 'audit:read') {
    return app.inject({
      url: `/v1/tasks/${taskId}/reconstruction?${query}`,
      headers: { authorization: `Bearer ${await makeToken(scope)}` },
    });
  }

  it('reconstructs a task from its records (the two seeded events share a task_id)', async () => {
    const res = await reconstruct(RECON_TASK, 'tenant=acme');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      task_id: string;
      integrity: { records: number };
      timeline: unknown[];
    }>();
    expect(body.task_id).toBe(RECON_TASK);
    expect(body.integrity.records).toBe(2);
    expect(body.timeline).toHaveLength(2);
  });

  it('404s an unknown task and a cross-tenant task, and 400s a non-uuid / missing tenant', async () => {
    expect((await reconstruct(RECON_TASK, 'tenant=other-tenant')).statusCode).toBe(404);
    const unknown = '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3fff';
    expect((await reconstruct(unknown, 'tenant=acme')).statusCode).toBe(404);
    expect((await reconstruct('not-a-uuid', 'tenant=acme')).statusCode).toBe(400);
    expect((await reconstruct(RECON_TASK, '')).statusCode).toBe(400);
    expect((await reconstruct(RECON_TASK, 'tenant=acme', 'task:submit')).statusCode).toBe(403);
  });

  it('serves the retention policy (default floor) behind audit:read', async () => {
    const res = await app.inject({
      url: '/v1/retention',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hot_days: RETENTION_FLOOR_DAYS,
      floor_days: RETENTION_FLOOR_DAYS,
      archival: 'deployment-policy',
      worm: 'deployment-policy',
    });
    const wrong = await app.inject({
      url: '/v1/retention',
      headers: { authorization: `Bearer ${await makeToken('task:submit')}` },
    });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('resolveRetentionHotDays (six-month floor)', () => {
  it('defaults to the floor when unset', () => {
    expect(resolveRetentionHotDays(undefined)).toBe(RETENTION_FLOOR_DAYS);
    expect(resolveRetentionHotDays('')).toBe(RETENTION_FLOOR_DAYS);
  });
  it('accepts a value at or above the floor', () => {
    expect(resolveRetentionHotDays('183')).toBe(183);
    expect(resolveRetentionHotDays('365')).toBe(365);
  });
  it('refuses a sub-floor or invalid value (fail-closed at boot)', () => {
    expect(() => resolveRetentionHotDays('182')).toThrow(/below the 183-day floor/);
    expect(() => resolveRetentionHotDays('0')).toThrow();
    expect(() => resolveRetentionHotDays('nope')).toThrow(/positive integer/);
  });
});
