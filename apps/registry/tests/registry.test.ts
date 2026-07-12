import type {
  AgentCard,
  AgentManifest,
  AuditEvent,
  Capability,
  EvalBaseline,
  LifecycleState,
} from '@acp/protocol';
import { JwtVerifier, createLogger, stableStringify } from '@acp/service-kit';
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
import { verifyCard } from '../src/signing.js';
import {
  InvariantViolation,
  type AgentFilter,
  type PutResult,
  type RegistryStore,
  type RoutingSet,
  type TransitionOptions,
} from '../src/store.js';

const ISSUER = 'https://token.test.local';

/** Versioned in-memory store mirroring the Postgres invariants (debt #3). */
class MemoryStore implements RegistryStore {
  readonly rows = new Map<string, { card: AgentCard; ramp: number | null }>();
  private key(id: string, v: string): string {
    return `${id}@${v}`;
  }
  private rowsOf(id: string): { card: AgentCard; ramp: number | null }[] {
    return [...this.rows.values()].filter((r) => r.card.manifest.id === id);
  }
  clear(): void {
    this.rows.clear();
  }
  cardOf(id: string, v: string): AgentCard | undefined {
    return this.rows.get(this.key(id, v))?.card;
  }
  migrate(): Promise<void> {
    return Promise.resolve();
  }
  put(card: AgentCard): Promise<PutResult> {
    const k = this.key(card.manifest.id, card.version);
    const existing = this.rows.get(k);
    if (existing === undefined) {
      this.rows.set(k, { card, ramp: null });
      return Promise.resolve({ outcome: 'inserted', card });
    }
    if (stableStringify(existing.card.manifest) === stableStringify(card.manifest)) {
      return Promise.resolve({ outcome: 'idempotent', card: existing.card });
    }
    return Promise.resolve({ outcome: 'conflict', existing: existing.card });
  }
  get(id: string): Promise<AgentCard | undefined> {
    const rank: Record<LifecycleState, number> = {
      active: 0,
      canary: 1,
      shadow: 2,
      deprecated: 3,
      registered: 4,
      suspended: 5,
      retired: 6,
    };
    const ranked = this.rowsOf(id)
      .map((r) => r.card)
      .sort((a, b) => {
        const s = rank[a.lifecycle_state] - rank[b.lifecycle_state];
        return s !== 0 ? s : b.updated_at.localeCompare(a.updated_at);
      });
    return Promise.resolve(ranked[0]);
  }
  getVersion(id: string, v: string): Promise<AgentCard | undefined> {
    return Promise.resolve(this.cardOf(id, v));
  }
  listVersions(id: string): Promise<AgentCard[]> {
    return Promise.resolve(
      this.rowsOf(id)
        .map((r) => r.card)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    );
  }
  list(filter: AgentFilter): Promise<AgentCard[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .map((r) => r.card)
        .filter(
          (c) =>
            (filter.state === undefined || c.lifecycle_state === filter.state) &&
            (filter.capability === undefined ||
              c.manifest.capabilities.some((cap) => cap.name === filter.capability)),
        ),
    );
  }
  routingSet(capability: string): Promise<RoutingSet> {
    const set: RoutingSet = {};
    for (const r of [...this.rows.values()].sort((a, b) =>
      a.card.version.localeCompare(b.card.version),
    )) {
      if (!r.card.manifest.capabilities.some((c) => c.name === capability)) continue;
      const s = r.card.lifecycle_state;
      if (s === 'active' && set.active === undefined) set.active = r.card;
      else if (s === 'canary' && set.canary === undefined)
        set.canary = { card: r.card, ramp_percent: r.ramp ?? 0 };
      else if (s === 'shadow' && set.shadow === undefined) set.shadow = r.card;
    }
    return Promise.resolve(set);
  }
  transition(
    id: string,
    v: string,
    to: LifecycleState,
    opts: TransitionOptions,
  ): Promise<AgentCard> {
    const row = this.rows.get(this.key(id, v));
    if (row === undefined) throw new Error(`no version ${v} of ${id}`);
    // Enforce the partial-unique invariants the DB enforces.
    if (
      to === 'active' &&
      this.rowsOf(id).some((r) => r !== row && r.card.lifecycle_state === 'active')
    ) {
      throw new InvariantViolation('one_active_version', 'another version is already active');
    }
    if (
      (to === 'shadow' || to === 'canary') &&
      this.rowsOf(id).some(
        (r) =>
          r !== row && (r.card.lifecycle_state === 'shadow' || r.card.lifecycle_state === 'canary'),
      )
    ) {
      throw new InvariantViolation('one_candidate_version', 'a candidate already exists');
    }
    const updated: AgentCard = {
      ...row.card,
      lifecycle_state: to,
      updated_at: opts.now,
      ...(opts.setDeployedAt === true ? { deployed_at: opts.now } : {}),
      ...(opts.reason !== undefined ? { state_reason: opts.reason } : {}),
    };
    row.card = updated;
    row.ramp = opts.rampPercent === undefined ? null : opts.rampPercent;
    return Promise.resolve(updated);
  }
  async promote(
    id: string,
    candidateVersion: string,
    now: string,
  ): Promise<{ incumbent?: AgentCard; candidate: AgentCard }> {
    const active = this.rowsOf(id).find((r) => r.card.lifecycle_state === 'active');
    let incumbent: AgentCard | undefined;
    if (active !== undefined) {
      incumbent = { ...active.card, lifecycle_state: 'deprecated', updated_at: now };
      active.card = incumbent;
    }
    const candRow = this.rows.get(this.key(id, candidateVersion));
    if (candRow === undefined) throw new Error('no candidate');
    if (candRow.card.lifecycle_state !== 'canary') throw new Error('candidate not canary');
    const candidate: AgentCard = {
      ...candRow.card,
      lifecycle_state: 'active',
      deployed_at: now,
      updated_at: now,
    };
    candRow.card = candidate;
    candRow.ramp = null;
    return Promise.resolve(incumbent === undefined ? { candidate } : { incumbent, candidate });
  }
  putBaseline(id: string, v: string, baseline: EvalBaseline): Promise<AgentCard> {
    const row = this.rows.get(this.key(id, v));
    if (row === undefined) throw new Error('no row');
    const updated: AgentCard = {
      ...row.card,
      eval_baseline: baseline,
      updated_at: new Date(Date.parse(row.card.updated_at) + 1000).toISOString(),
    };
    row.card = updated;
    return Promise.resolve(updated);
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
const flips: { op: string; target: string; reason?: string; by?: string }[] = [];

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
    control: {
      suspendCapability: (name, reason, by) => (
        flips.push({ op: 'suspendCapability', target: name, reason, by }),
        Promise.resolve()
      ),
      reinstateCapability: (name) => (
        flips.push({ op: 'reinstateCapability', target: name }),
        Promise.resolve()
      ),
      suspendRiskClass: (cls, reason, by) => (
        flips.push({ op: 'suspendRiskClass', target: cls, reason, by }),
        Promise.resolve()
      ),
      reinstateRiskClass: (cls) => (
        flips.push({ op: 'reinstateRiskClass', target: cls }),
        Promise.resolve()
      ),
      haltFleet: (reason, by) => (
        flips.push({ op: 'haltFleet', target: 'fleet', reason, by }),
        Promise.resolve()
      ),
      resumeFleet: () => (flips.push({ op: 'resumeFleet', target: 'fleet' }), Promise.resolve()),
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
  store.clear();
  announcements.length = 0;
  suspensions.length = 0;
  auditEvents.length = 0;
  flips.length = 0;
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

/** Legacy single-version state route (admin). */
async function transition(agentId: string, state: LifecycleState, reason?: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/state`,
    headers: { authorization: `Bearer ${await makeToken('registry:admin')}` },
    payload: { state, ...(reason === undefined ? {} : { reason }) },
  });
}

/** Versioned state route with an explicit scope + optional ramp. */
async function transitionVersion(
  agentId: string,
  version: string,
  state: LifecycleState,
  opts: { scope?: string; reason?: string; ramp_percent?: number } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/versions/${version}/state`,
    headers: { authorization: `Bearer ${await makeToken(opts.scope ?? 'registry:deploy')}` },
    payload: {
      state,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
      ...(opts.ramp_percent === undefined ? {} : { ramp_percent: opts.ramp_percent }),
    },
  });
}

function baseline(overrides: Partial<EvalBaseline> = {}): EvalBaseline {
  return {
    schema: 'acp-eval-baseline/v1',
    agent_id: 'knowledge-agent',
    agent_version: '0.1.0',
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    suite: { digest: `sha256:${'0'.repeat(64)}`, case_count: 7 },
    harness: 'acp-agent-sdk-py@0.1.0',
    recorded_at: '2026-07-11T09:00:00Z',
    ...overrides,
  };
}

async function putBaseline(agentId: string, body: unknown, scope = 'registry:write') {
  return app.inject({
    method: 'PUT',
    url: `/v1/agents/${agentId}/baseline`,
    headers: { authorization: `Bearer ${await makeToken(scope)}` },
    payload: body as Record<string, unknown>,
  });
}

/** Registers, records a baseline, and drives registered→shadow→canary. */
async function makeCanary(version: string, ramp = 5): Promise<void> {
  await register({ manifest: manifest(), version });
  await putBaseline('knowledge-agent', baseline({ agent_version: version }));
  await transitionVersion('knowledge-agent', version, 'shadow');
  await transitionVersion('knowledge-agent', version, 'canary', { ramp_percent: ramp });
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

  it('is idempotent on an identical re-registration (200, no sibling touch)', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    announcements.length = 0;
    const again = await register({ manifest: manifest(), version: '0.1.0' });
    expect(again.statusCode).toBe(200);
    // No second announcement/audit for an idempotent re-register.
    expect(announcements).toHaveLength(0);
  });

  it('409s a changed manifest under the same version (bump the version)', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    const changed = await register({
      manifest: manifest({ description: 'a different contract' }),
      version: '0.1.0',
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ error: { message: string } }>().error.message).toContain(
      'bump the version',
    );
  });

  it('a new version never touches sibling rows (debt #3)', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    await transition('knowledge-agent', 'active');
    await putBaseline('knowledge-agent', baseline({ agent_version: '0.1.0' }));
    const activeBefore = store.cardOf('knowledge-agent', '0.1.0')!;

    const res = await register({ manifest: manifest(), version: '0.2.0' });
    expect(res.statusCode).toBe(201);
    // The incumbent's active card + baseline are untouched.
    const activeAfter = store.cardOf('knowledge-agent', '0.1.0')!;
    expect(activeAfter.lifecycle_state).toBe('active');
    expect(activeAfter.eval_baseline).toEqual(activeBefore.eval_baseline);
    expect(store.cardOf('knowledge-agent', '0.2.0')!.lifecycle_state).toBe('registered');
  });

  it('detects card tampering after signature', async () => {
    const res = await register({ manifest: manifest(), version: '0.1.0' });
    const card = res.json<AgentCard>();
    const tampered: AgentCard = { ...card, manifest: { ...card.manifest, owner: 'team-evil' } };
    expect(await verifyCard(tampered, registryJwks)).toBe(false);
  });

  it('rejects schema-invalid manifests with the violation named', async () => {
    const res = await register({ manifest: { id: 'x' }, version: '0.1.0' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('agent-manifest');
  });

  const r2Cap = (over: Partial<Capability> = {}): Capability => ({
    name: 'change.submit',
    description: 'Submit a change record.',
    risk: 'R2',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    examples: [{ input: {} }, { input: {} }, { input: {} }],
    ...over,
  });
  const withdrawCap = (over: Partial<Capability> = {}): Capability => ({
    name: 'change.withdraw',
    description: 'Withdraw a submitted change record.',
    risk: 'R1',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    examples: [{ input: {} }, { input: {} }, { input: {} }],
    ...over,
  });

  it('rejects R2 capabilities without a compensator, accepts irreversible:true', async () => {
    const rejected = await register({
      manifest: manifest({ capabilities: [r2Cap()] }),
      version: '0.1.0',
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { message: string } }>().error.message).toContain('compensator');

    const withCompensator = await register({
      manifest: manifest({
        capabilities: [r2Cap({ compensator: 'change.withdraw' }), withdrawCap()],
      }),
      version: '0.2.0',
    });
    expect(withCompensator.statusCode).toBe(201);

    const irreversible = await register({
      manifest: manifest({ capabilities: [r2Cap({ irreversible: true })] }),
      version: '0.3.0',
    });
    expect(irreversible.statusCode).toBe(201);
  });

  it('accepts a mutual compensator pair (gov.test_write ⇄ gov.test_undo)', async () => {
    const res = await register({
      manifest: manifest({
        capabilities: [
          r2Cap({ name: 'gov.test_write', compensator: 'gov.test_undo' }),
          r2Cap({ name: 'gov.test_undo', compensator: 'gov.test_write' }),
        ],
      }),
      version: '0.1.0',
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a compensator+irreversible contradiction', async () => {
    const res = await register({
      manifest: manifest({
        capabilities: [
          r2Cap({ compensator: 'change.withdraw', irreversible: true }),
          withdrawCap(),
        ],
      }),
      version: '0.1.0',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('contradict');
  });

  it('rejects a dangling compensator that names no capability in the manifest', async () => {
    const res = await register({
      manifest: manifest({ capabilities: [r2Cap({ compensator: 'change.withdraw' })] }),
      version: '0.1.0',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('not a capability');
  });

  it('rejects a self-referential compensator', async () => {
    const res = await register({
      manifest: manifest({ capabilities: [r2Cap({ compensator: 'change.submit' })] }),
      version: '0.1.0',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('itself');
  });

  it('rejects a compensator whose own risk is R0 or R3, accepts R1', async () => {
    const r0Comp = await register({
      manifest: manifest({
        capabilities: [r2Cap({ compensator: 'change.withdraw' }), withdrawCap({ risk: 'R0' })],
      }),
      version: '0.1.0',
    });
    expect(r0Comp.statusCode).toBe(400);
    expect(r0Comp.json<{ error: { message: string } }>().error.message).toContain('R0');

    const r1Comp = await register({
      manifest: manifest({
        capabilities: [r2Cap({ compensator: 'change.withdraw' }), withdrawCap({ risk: 'R1' })],
      }),
      version: '0.2.0',
    });
    expect(r1Comp.statusCode).toBe(201);
  });

  it('rejects an R0 with a compensator or irreversible, and an R1 with irreversible', async () => {
    const r0Comp = await register({
      manifest: manifest({
        capabilities: [
          { ...manifest().capabilities[0], compensator: 'change.withdraw' },
          withdrawCap(),
        ],
      }),
      version: '0.1.0',
    });
    expect(r0Comp.statusCode).toBe(400);
    expect(r0Comp.json<{ error: { message: string } }>().error.message).toContain('R0');

    const r0Irr = await register({
      manifest: manifest({
        capabilities: [{ ...manifest().capabilities[0], irreversible: true }],
      }),
      version: '0.2.0',
    });
    expect(r0Irr.statusCode).toBe(400);

    const r1Irr = await register({
      manifest: manifest({ capabilities: [withdrawCap({ irreversible: true })] }),
      version: '0.3.0',
    });
    expect(r1Irr.statusCode).toBe(400);
    expect(r1Irr.json<{ error: { message: string } }>().error.message).toContain('R1');
  });

  it('accepts an r0/r1-only manifest that declares no compensator (netsec-agent shape)', async () => {
    // Rule 6: R0 declares neither compensator nor irreversible; R1 may declare
    // a compensator but never needs one. A read-plus-draft agent (the netsec
    // v0 posture: R0 reads + a side-effect-free R1 draft, zero write surface)
    // must register without any compensation machinery.
    const res = await register({
      manifest: manifest({
        capabilities: [
          {
            name: 'netsec.rule_search',
            description: 'Search the firewall ruleset.',
            risk: 'R0',
            input_schema: { type: 'object' },
            output_schema: { type: 'object' },
            examples: [{ input: {} }, { input: {} }, { input: {} }],
          },
          {
            name: 'netsec.rule_draft',
            description: 'Draft a reviewable rule change; nothing is applied.',
            risk: 'R1',
            input_schema: { type: 'object' },
            output_schema: { type: 'object' },
            examples: [{ input: {} }, { input: {} }, { input: {} }],
          },
        ],
      }),
      version: '0.1.0',
    });
    expect(res.statusCode).toBe(201);
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

  it('representative get() prefers active over other states', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    await transition('knowledge-agent', 'active');
    await register({ manifest: manifest(), version: '0.2.0' });
    const byId = await app.inject({
      url: '/v1/agents/knowledge-agent',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(byId.json<AgentCard>().version).toBe('0.1.0');
  });

  it('lists all versions of an agent', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    await register({ manifest: manifest(), version: '0.2.0' });
    const res = await app.inject({
      url: '/v1/agents/knowledge-agent/versions',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(res.json<{ versions: AgentCard[] }>().versions).toHaveLength(2);

    const one = await app.inject({
      url: '/v1/agents/knowledge-agent/versions/0.2.0',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(one.json<AgentCard>().version).toBe('0.2.0');
  });
});

describe('legacy single-version state route', () => {
  beforeEach(async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    announcements.length = 0;
    auditEvents.length = 0;
  });

  it('bootstraps registered → active (admin) and stamps deployed_at', async () => {
    const res = await transition('knowledge-agent', 'active');
    expect(res.statusCode).toBe(200);
    const card = res.json<AgentCard>();
    expect(card.lifecycle_state).toBe('active');
    expect(card.deployed_at).toBeDefined();
    expect(auditEvents.map((e) => e.event_type)).toEqual(['agent.lifecycle_changed']);
  });

  it('suspends active then reinstates, flipping the kill-switch flag both ways', async () => {
    await transition('knowledge-agent', 'active');
    suspensions.length = 0;
    auditEvents.length = 0;

    const susp = await transition('knowledge-agent', 'suspended', 'bad citations');
    expect(susp.statusCode).toBe(200);
    expect(suspensions).toEqual([
      { agentId: 'knowledge-agent', suspended: true, reason: 'bad citations' },
    ]);
    expect(auditEvents.map((e) => e.event_type)).toEqual([
      'agent.lifecycle_changed',
      'killswitch.activated',
    ]);

    suspensions.length = 0;
    auditEvents.length = 0;
    const reinstate = await transition('knowledge-agent', 'active', 'drill complete');
    expect(reinstate.statusCode).toBe(200);
    expect(suspensions).toEqual([
      { agentId: 'knowledge-agent', suspended: false, reason: 'drill complete' },
    ]);
    expect(auditEvents.map((e) => e.event_type)).toEqual([
      'agent.lifecycle_changed',
      'killswitch.cleared',
    ]);
  });

  it('rejects an illegal transition and is 409 ambiguous for a multi-version agent', async () => {
    const illegal = await transition('knowledge-agent', 'suspended');
    expect(illegal.statusCode).toBe(409);

    await register({ manifest: manifest(), version: '0.2.0' });
    const ambiguous = await transition('knowledge-agent', 'active');
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json<{ error: { message: string } }>().error.message).toContain('ambiguous');
  });

  it('404s on unknown agents', async () => {
    expect((await transition('ghost-agent', 'active')).statusCode).toBe(404);
  });
});

describe('versioned transitions and scope classes', () => {
  beforeEach(async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    await putBaseline('knowledge-agent', baseline({ agent_version: '0.1.0' }));
    announcements.length = 0;
    auditEvents.length = 0;
  });

  it('registered → shadow requires a baseline and registry:deploy', async () => {
    // Without a baseline: register a second, baseline-less version.
    await register({ manifest: manifest(), version: '0.2.0' });
    const noBaseline = await transitionVersion('knowledge-agent', '0.2.0', 'shadow');
    expect(noBaseline.statusCode).toBe(409);
    expect(noBaseline.json<{ error: { message: string } }>().error.message).toContain(
      'eval_baseline',
    );

    // A deploy edge driven with only admin scope is 403.
    const wrongScope = await transitionVersion('knowledge-agent', '0.1.0', 'shadow', {
      scope: 'registry:admin',
    });
    expect(wrongScope.statusCode).toBe(403);

    const ok = await transitionVersion('knowledge-agent', '0.1.0', 'shadow');
    expect(ok.statusCode).toBe(200);
    expect(ok.json<AgentCard>().lifecycle_state).toBe('shadow');
  });

  it('shadow → canary requires ramp_percent 1-100; canary → shadow clears it', async () => {
    await transitionVersion('knowledge-agent', '0.1.0', 'shadow');
    const noRamp = await transitionVersion('knowledge-agent', '0.1.0', 'canary');
    expect(noRamp.statusCode).toBe(400);
    const badRamp = await transitionVersion('knowledge-agent', '0.1.0', 'canary', {
      ramp_percent: 0,
    });
    expect(badRamp.statusCode).toBe(400);

    const ok = await transitionVersion('knowledge-agent', '0.1.0', 'canary', { ramp_percent: 25 });
    expect(ok.statusCode).toBe(200);
    expect(store.rows.get('knowledge-agent@0.1.0')!.ramp).toBe(25);

    const demote = await transitionVersion('knowledge-agent', '0.1.0', 'shadow');
    expect(demote.statusCode).toBe(200);
    expect(store.rows.get('knowledge-agent@0.1.0')!.ramp).toBeNull();
  });

  it('refuses canary → active on the state route (promote only)', async () => {
    await transitionVersion('knowledge-agent', '0.1.0', 'shadow');
    await transitionVersion('knowledge-agent', '0.1.0', 'canary', { ramp_percent: 50 });
    const res = await transitionVersion('knowledge-agent', '0.1.0', 'active');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('promote');
  });

  it('enforces one_candidate_version: a second shadow is 409', async () => {
    await register({ manifest: manifest(), version: '0.2.0' });
    await putBaseline('knowledge-agent', baseline({ agent_version: '0.2.0' }));
    await transitionVersion('knowledge-agent', '0.1.0', 'shadow');
    const second = await transitionVersion('knowledge-agent', '0.2.0', 'shadow');
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { message: string } }>().error.message).toContain('candidate');
  });
});

describe('promote (atomic)', () => {
  it('promotes canary → active and demotes the incumbent, 2 announcements + 2 audits', async () => {
    // Incumbent 0.1.0 active.
    await register({ manifest: manifest(), version: '0.1.0' });
    await transition('knowledge-agent', 'active');
    // Candidate 0.2.0 → canary.
    await makeCanary('0.2.0', 50);
    announcements.length = 0;
    auditEvents.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/knowledge-agent/promote',
      headers: { authorization: `Bearer ${await makeToken('registry:deploy')}` },
      payload: { version: '0.2.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.cardOf('knowledge-agent', '0.2.0')!.lifecycle_state).toBe('active');
    expect(store.cardOf('knowledge-agent', '0.2.0')!.deployed_at).toBeDefined();
    expect(store.cardOf('knowledge-agent', '0.1.0')!.lifecycle_state).toBe('deprecated');
    expect(announcements.map((a) => a.verb)).toEqual(['updated', 'updated']);
    expect(auditEvents.map((e) => e.event_type)).toEqual([
      'agent.lifecycle_changed',
      'agent.lifecycle_changed',
    ]);
  });

  it('first-ever promote with no incumbent emits one lifecycle_changed', async () => {
    await makeCanary('0.1.0', 100);
    announcements.length = 0;
    auditEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/knowledge-agent/promote',
      headers: { authorization: `Bearer ${await makeToken('registry:deploy')}` },
      payload: { version: '0.1.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(auditEvents).toHaveLength(1);
  });

  it('409s promoting a non-canary version and requires registry:deploy', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    const notCanary = await app.inject({
      method: 'POST',
      url: '/v1/agents/knowledge-agent/promote',
      headers: { authorization: `Bearer ${await makeToken('registry:deploy')}` },
      payload: { version: '0.1.0' },
    });
    expect(notCanary.statusCode).toBe(409);

    const wrongScope = await app.inject({
      method: 'POST',
      url: '/v1/agents/knowledge-agent/promote',
      headers: { authorization: `Bearer ${await makeToken('registry:admin')}` },
      payload: { version: '0.1.0' },
    });
    expect(wrongScope.statusCode).toBe(403);
  });
});

describe('routing view', () => {
  it('returns active + candidate for a capability', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    await transition('knowledge-agent', 'active');
    await makeCanary('0.2.0', 25);

    const res = await app.inject({
      url: '/v1/routing?capability=knowledge.search',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(res.statusCode).toBe(200);
    const set = res.json<RoutingSet>();
    expect(set.active?.version).toBe('0.1.0');
    expect(set.canary?.card.version).toBe('0.2.0');
    expect(set.canary?.ramp_percent).toBe(25);
    expect(set.shadow).toBeUndefined();
  });

  it('requires a capability parameter', async () => {
    const res = await app.inject({
      url: '/v1/routing',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('baseline recording (version-aware)', () => {
  beforeEach(async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    announcements.length = 0;
    auditEvents.length = 0;
  });

  it('records the baseline on its own version, announces, and audits', async () => {
    const before = store.cardOf('knowledge-agent', '0.1.0')!;
    const res = await putBaseline('knowledge-agent', baseline());
    expect(res.statusCode).toBe(200);
    const card = res.json<AgentCard>();
    expect(card.eval_baseline).toEqual(baseline());
    expect(card.card_signature).toBe(before.card_signature);
    expect(announcements.map((a) => a.verb)).toEqual(['updated']);
    expect(auditEvents.map((e) => e.event_type)).toEqual(['agent.baseline_recorded']);
  });

  it('a candidate baseline never clobbers the incumbent (debt #3)', async () => {
    await putBaseline('knowledge-agent', baseline());
    await register({ manifest: manifest(), version: '0.2.0' });
    await putBaseline(
      'knowledge-agent',
      baseline({
        agent_version: '0.2.0',
        metrics: { pass_rate: 0.7, citation_precision: 1, abstention_accuracy: 1 },
      }),
    );
    expect(store.cardOf('knowledge-agent', '0.1.0')!.eval_baseline?.metrics.pass_rate).toBe(1);
    expect(store.cardOf('knowledge-agent', '0.2.0')!.eval_baseline?.metrics.pass_rate).toBe(0.7);
  });

  it('404s for a version that is not registered', async () => {
    const res = await putBaseline('knowledge-agent', baseline({ agent_version: '9.9.9' }));
    expect(res.statusCode).toBe(404);
  });

  it('rejects a baseline recorded for a different agent', async () => {
    const res = await putBaseline('knowledge-agent', baseline({ agent_id: 'other-agent' }));
    expect(res.statusCode).toBe(400);
  });

  it('requires the registry:write scope', async () => {
    const res = await putBaseline('knowledge-agent', baseline(), 'registry:read');
    expect(res.statusCode).toBe(403);
  });
});

describe('tier-2/3 kill-switch flip routes', () => {
  async function flip(path: string, body: Record<string, unknown>, scope = 'registry:admin') {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${await makeToken(scope)}` },
      payload: body,
    });
  }

  it('suspends a capability: KV flip before an audited killswitch.activated', async () => {
    const res = await flip('/v1/killswitch/capability/change.submit', {
      active: true,
      reason: 'bad drafts',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ tier: 'capability', target: 'change.submit', active: true });
    // Flip happened before the audit (KV first, event second).
    expect(flips).toEqual([
      {
        op: 'suspendCapability',
        target: 'change.submit',
        reason: 'bad drafts',
        by: 'svc:agent-ci',
      },
    ]);
    const audit = auditEvents.at(-1)!;
    expect(audit.event_type).toBe('killswitch.activated');
    expect(audit.tenant).toBe('platform');
    expect(audit.actor.principal).toBe('svc:agent-ci');
    expect(audit.details).toMatchObject({
      tier: 'capability',
      target: 'change.submit',
      reason: 'bad drafts',
    });
  });

  it('reinstates a capability with killswitch.cleared', async () => {
    const res = await flip('/v1/killswitch/capability/change.submit', {
      active: false,
      reason: 'drill complete',
    });
    expect(res.statusCode).toBe(202);
    expect(flips).toEqual([{ op: 'reinstateCapability', target: 'change.submit' }]);
    expect(auditEvents.at(-1)!.event_type).toBe('killswitch.cleared');
  });

  it('suspends a risk class but refuses R0 (halt the fleet instead)', async () => {
    const ok = await flip('/v1/killswitch/risk/R2', { active: true, reason: 'estate incident' });
    expect(ok.statusCode).toBe(202);
    expect(flips.at(-1)).toMatchObject({ op: 'suspendRiskClass', target: 'R2' });

    const r0 = await flip('/v1/killswitch/risk/R0', { active: true, reason: 'x' });
    expect(r0.statusCode).toBe(400);
  });

  it('halts and resumes the fleet', async () => {
    expect((await flip('/v1/killswitch/fleet', { active: true, reason: 'p1' })).statusCode).toBe(
      202,
    );
    expect(flips.at(-1)).toMatchObject({ op: 'haltFleet', reason: 'p1' });
    expect(
      (await flip('/v1/killswitch/fleet', { active: false, reason: 'recovered' })).statusCode,
    ).toBe(202);
    expect(flips.at(-1)).toMatchObject({ op: 'resumeFleet' });
  });

  it('rejects a bad capability name, a missing reason, and a missing active flag', async () => {
    expect(
      (await flip('/v1/killswitch/capability/NotACap', { active: true, reason: 'x' })).statusCode,
    ).toBe(400);
    expect((await flip('/v1/killswitch/fleet', { active: true })).statusCode).toBe(400);
    expect((await flip('/v1/killswitch/fleet', { reason: 'x' })).statusCode).toBe(400);
  });

  it('requires authentication and the registry:admin scope', async () => {
    const noauth = await app.inject({
      method: 'POST',
      url: '/v1/killswitch/fleet',
      payload: { active: true, reason: 'x' },
    });
    expect(noauth.statusCode).toBe(401);
    const wrongScope = await flip(
      '/v1/killswitch/fleet',
      { active: true, reason: 'x' },
      'registry:deploy',
    );
    expect(wrongScope.statusCode).toBe(403);
    expect(flips).toHaveLength(0);
  });
});

describe('edge cases', () => {
  it('verifyCard returns false for garbage signatures instead of throwing', async () => {
    await register({ manifest: manifest(), version: '0.1.0' });
    const card = store.cardOf('knowledge-agent', '0.1.0')!;
    expect(await verifyCard({ ...card, card_signature: 'not-a-jws' }, registryJwks)).toBe(false);
  });

  it('rejects a registration with no manifest at all', async () => {
    const res = await register({ version: '0.1.0' });
    expect(res.statusCode).toBe(400);
  });
});
