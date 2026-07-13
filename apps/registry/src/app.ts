import { randomUUID } from 'node:crypto';
import {
  agentCard,
  agentManifest,
  evalBaseline,
  ProtocolValidationError,
  toolServerRecord,
  type AgentCard,
  type AgentManifest,
  type AuditEvent,
  type EvalBaseline,
  type LifecycleState,
  type ToolServerRecord,
} from '@acp/protocol';
import {
  AuthError,
  createHttpServer,
  delegationChain,
  scopesOf,
  type JwtVerifier,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JSONWebKeySet, CryptoKey } from 'jose';
import { signA2ACard, toA2ACard, type A2ACardOptions } from './a2a.js';
import { signCard } from './signing.js';
import { InvariantViolation, type AgentFilter, type RegistryStore } from './store.js';
import type { ToolServerStore } from './tool-servers.js';

export const REGISTRY_AUDIENCE = 'acp:registry';

export interface RegistryAnnouncer {
  /** Publishes the registry event and refreshes the KV cache snapshot. */
  announce(verb: 'registered' | 'updated', card: AgentCard): Promise<void>;
  /** Fast-path kill-switch flag; routers react without polling. */
  setSuspended(agentId: string, suspended: boolean, reason: string, by: string): Promise<void>;
}

export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

/**
 * The write side of the tier-2/3 kill switch (capability/risk/fleet). The
 * registry owns the audited flip surface; this seam flips the fast-path control
 * KV (structurally KillSwitchControl) so routers react within the <10s SLO. The
 * agent tier keeps its own /state route (announcer.setSuspended); this is only
 * the platform-wide capability/risk/fleet flags.
 */
export interface KillSwitchControlLike {
  suspendCapability(name: string, reason: string, activatedBy: string): Promise<void>;
  reinstateCapability(name: string): Promise<void>;
  suspendRiskClass(riskClass: string, reason: string, activatedBy: string): Promise<void>;
  reinstateRiskClass(riskClass: string): Promise<void>;
  haltFleet(reason: string, activatedBy: string): Promise<void>;
  resumeFleet(): Promise<void>;
}

/**
 * A2A export configuration (item 3, SF1). Exposure is PLATFORM-controlled
 * (deploy config), never agent-authored: an agent cannot self-expose by
 * editing its manifest. An empty set exports nothing — the secure default.
 */
export interface A2AExportConfig {
  exposure: Set<string>;
  /** Public platform edge base URL (the gateway). */
  edgeBaseUrl: string;
  /** Platform organization constant shown as the card provider. */
  providerOrg: string;
  providerUrl?: string | undefined;
  /** Public token endpoint external consumers authenticate at. */
  tokenUrl: string;
}

export interface RegistryDeps {
  verifier: JwtVerifier;
  store: RegistryStore;
  signingKey: { kid: string; privateKey: CryptoKey };
  jwks: JSONWebKeySet;
  announcer: RegistryAnnouncer;
  /** Tier-2/3 kill-switch flip surface (capability/risk/fleet flags). */
  control: KillSwitchControlLike;
  /** A2A card export: allowlist + projection options. */
  a2a: A2AExportConfig;
  /** MCP tool-server catalog (SF3). Authed-internal reads + admin publish. */
  toolServers: ToolServerStore;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const RISK_CLASS_TARGETS = new Set(['R1', 'R2', 'R3']);

/**
 * The full lifecycle transition table (agent-lifecycle.md), split by the scope
 * class that may drive each edge (debt #3). `deploy` = registry:deploy (the
 * Deployment Controller, svc:orchestrator); `admin` = registry:admin (an
 * operator); `both` accepts either. canary→active and active→deprecated are
 * DELIBERATELY absent — they happen only via the atomic /promote route.
 */
// `sanction` = the narrow *→suspended edge: registry:admin OR the online-eval
// SLO-floor's registry:suspend scope (item 6, D6) may drive it. registry:suspend
// is valid ONLY on this edge — it cannot reinstate or drive any other
// transition, so an automated quality sanction cannot become a general
// registry-admin capability.
type ScopeClass = 'deploy' | 'admin' | 'both' | 'sanction';
const TRANSITIONS: Record<string, Partial<Record<LifecycleState, ScopeClass>>> = {
  registered: { shadow: 'deploy', active: 'admin', retired: 'admin' },
  shadow: { canary: 'deploy', suspended: 'sanction', retired: 'admin' },
  canary: { shadow: 'deploy', canary: 'deploy', suspended: 'sanction' },
  active: { suspended: 'sanction' },
  deprecated: { retired: 'both' },
  // agent-lifecycle.md sends suspended agents back through shadow to re-earn
  // trust; suspended→active is the documented v0 legacy edge that keeps the
  // kill-switch reinstatement E2E working (deviation noted in the design).
  // Reinstatement stays admin-only — registry:suspend can suspend but never lift.
  suspended: { shadow: 'admin', active: 'admin' },
};

const SCOPE_FOR: Record<ScopeClass, string[]> = {
  deploy: ['registry:deploy'],
  admin: ['registry:admin'],
  both: ['registry:deploy', 'registry:admin'],
  sanction: ['registry:admin', 'registry:suspend'],
};

export function buildRegistryApp(deps: RegistryDeps): FastifyInstance {
  const app = createHttpServer({ serviceName: 'registry', logger: deps.logger });
  const now = (): Date => deps.now?.() ?? new Date();

  app.get('/.well-known/jwks.json', () => deps.jwks);

  app.post('/v1/agents', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:write');
    const body = (request.body ?? {}) as { manifest?: unknown; version?: unknown };

    let manifest: AgentManifest;
    try {
      manifest = agentManifest.parse(body.manifest);
    } catch (err) {
      if (err instanceof ProtocolValidationError) throw new AuthError(err.message, 400);
      throw err;
    }
    validateRegistrationRules(manifest);
    if (typeof body.version !== 'string') {
      throw new AuthError('version (semver of the capability contract) is required', 400);
    }

    const registeredAt = now().toISOString();
    const card: AgentCard = agentCard.parse({
      manifest,
      version: body.version,
      lifecycle_state: 'registered',
      registered_at: registeredAt,
      updated_at: registeredAt,
      card_signature: await signCard(deps.signingKey, manifest, body.version, registeredAt),
    } satisfies Partial<AgentCard>);

    // Version-aware registration (debt #3): a new (id,version) never touches
    // sibling rows — an incumbent's active card and its baseline are
    // unclobberable. Re-registering the SAME (id,version) is idempotent only
    // when the manifest contract is byte-identical; a changed contract under
    // the same version is a 409 (bump the version).
    const result = await deps.store.put(card);
    if (result.outcome === 'conflict') {
      return reply.status(409).send({
        error: {
          message:
            `${manifest.id}@${body.version} is already registered with a different manifest — ` +
            'bump the version to register a changed capability contract',
          status: 409,
        },
      });
    }
    if (result.outcome === 'idempotent') {
      return reply.status(200).send(result.card);
    }
    await deps.announcer.announce('registered', card);
    await emitAudit(deps, claims, 'agent.registered', card, {
      version: card.version,
    });
    return reply.status(201).send(card);
  });

  app.get('/v1/agents/:agent_id', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { agent_id } = request.params as { agent_id: string };
    const card = await deps.store.get(agent_id);
    if (card === undefined) {
      return reply
        .status(404)
        .send({ error: { message: `no agent registered with id ${agent_id}`, status: 404 } });
    }
    return reply.send(card);
  });

  app.get('/v1/agents', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const query = request.query as { capability?: string; state?: string };
    const filter: AgentFilter = {
      capability: query.capability,
      state: query.state as LifecycleState | undefined,
    };
    return { agents: await deps.store.list(filter) };
  });

  // Legacy single-version state route (kept for registerAndActivate, the
  // kill-switch, and the existing E2E). Resolves to the agent's ONLY version;
  // a multi-version agent is 409 ambiguous — use the versioned route below.
  app.post('/v1/agents/:agent_id/state', async (request, reply) => {
    const claims = await authenticate(deps, request);
    const { agent_id } = request.params as { agent_id: string };
    const body = (request.body ?? {}) as { state?: string; reason?: string };

    const versions = await deps.store.listVersions(agent_id);
    if (versions.length === 0) {
      return reply
        .status(404)
        .send({ error: { message: `no agent registered with id ${agent_id}`, status: 404 } });
    }
    if (versions.length > 1) {
      return reply.status(409).send({
        error: {
          message:
            `agent ${agent_id} has ${versions.length} versions — the single-version state route is ` +
            'ambiguous; use POST /v1/agents/:id/versions/:version/state',
          status: 409,
        },
      });
    }
    const card = versions[0];
    if (card === undefined) {
      throw new AuthError(`no versions for agent ${agent_id}`, 404);
    }
    return applyStateTransition(deps, now, request, reply, claims, card, {
      target: body.state as LifecycleState | undefined,
      reason: body.reason,
      // The legacy route carries the admin edges (registered→active,
      // suspended→active/…) plus the sanction edge (→suspended, which
      // registry:admin or the online-eval registry:suspend scope may drive). A
      // deploy-only edge belongs on the versioned route.
      allowedClasses: ['admin', 'both', 'sanction'],
    });
  });

  // Versioned lifecycle route (debt #3): drives one (agent_id, version) across
  // the full transition table. The scope class of the (from,to) edge decides
  // which scope is required — deploy edges are the Deployment Controller's, admin
  // edges an operator's.
  app.post('/v1/agents/:agent_id/versions/:version/state', async (request, reply) => {
    const claims = await authenticate(deps, request);
    const { agent_id, version } = request.params as { agent_id: string; version: string };
    const body = (request.body ?? {}) as { state?: string; reason?: string; ramp_percent?: number };

    const card = await deps.store.getVersion(agent_id, version);
    if (card === undefined) {
      return reply.status(404).send({
        error: { message: `no version ${version} of agent ${agent_id}`, status: 404 },
      });
    }
    return applyStateTransition(deps, now, request, reply, claims, card, {
      target: body.state as LifecycleState | undefined,
      reason: body.reason,
      rampPercent: body.ramp_percent,
      allowedClasses: ['deploy', 'admin', 'both', 'sanction'],
    });
  });

  // Atomic promote (debt #3): incumbent active→deprecated and candidate
  // canary→active in ONE transaction, its atomicity forced by the
  // one_active_version index. The Deployment Controller's terminal step.
  app.post('/v1/agents/:agent_id/promote', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:deploy');
    const { agent_id } = request.params as { agent_id: string };
    const body = (request.body ?? {}) as { version?: string };
    if (typeof body.version !== 'string' || body.version === '') {
      throw new AuthError('version (the canary to promote) is required', 400);
    }
    const candidate = await deps.store.getVersion(agent_id, body.version);
    if (candidate === undefined) {
      return reply.status(404).send({
        error: { message: `no version ${body.version} of agent ${agent_id}`, status: 404 },
      });
    }
    if (candidate.lifecycle_state !== 'canary') {
      return reply.status(409).send({
        error: {
          message:
            `only a canary version can be promoted; ${agent_id}@${body.version} is ` +
            candidate.lifecycle_state,
          status: 409,
        },
      });
    }

    let promoted: Awaited<ReturnType<RegistryStore['promote']>>;
    try {
      promoted = await deps.store.promote(agent_id, body.version, now().toISOString());
    } catch (err) {
      if (err instanceof InvariantViolation) {
        return reply.status(409).send({ error: { message: err.message, status: 409 } });
      }
      throw err;
    }

    // Two announcements + two lifecycle_changed audits: the demoted incumbent
    // (if any) and the newly-active candidate.
    if (promoted.incumbent !== undefined) {
      await deps.announcer.announce('updated', promoted.incumbent);
      await emitAudit(deps, claims, 'agent.lifecycle_changed', promoted.incumbent, {
        from: 'active',
        to: 'deprecated',
        reason: `superseded by ${body.version} via promote`,
      });
    }
    await deps.announcer.announce('updated', promoted.candidate);
    await emitAudit(deps, claims, 'agent.lifecycle_changed', promoted.candidate, {
      from: 'canary',
      to: 'active',
      reason: `promoted${promoted.incumbent === undefined ? ' (first active)' : ''}`,
    });
    return reply.send({
      candidate: promoted.candidate,
      ...(promoted.incumbent === undefined ? {} : { incumbent: promoted.incumbent }),
    });
  });

  app.get('/v1/agents/:agent_id/versions', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { agent_id } = request.params as { agent_id: string };
    const versions = await deps.store.listVersions(agent_id);
    if (versions.length === 0) {
      return reply
        .status(404)
        .send({ error: { message: `no agent registered with id ${agent_id}`, status: 404 } });
    }
    return reply.send({ versions });
  });

  app.get('/v1/agents/:agent_id/versions/:version', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { agent_id, version } = request.params as { agent_id: string; version: string };
    const card = await deps.store.getVersion(agent_id, version);
    if (card === undefined) {
      return reply.status(404).send({
        error: { message: `no version ${version} of agent ${agent_id}`, status: 404 },
      });
    }
    return reply.send(card);
  });

  // --- A2A card export (SF1). Authed-internal (registry:read): the gateway
  // fetches these and serves the public edge. Exposure is the PLATFORM
  // allowlist above; a non-exposed agent and an unknown agent answer an
  // IDENTICAL 404 — a 403 would confirm existence to a snoop. Cards are
  // translated by the strict allowlist projection and re-signed with the
  // registry key (the sole signer); the internal JWS never ships.

  const a2aOptions: A2ACardOptions = {
    edgeBaseUrl: deps.a2a.edgeBaseUrl,
    providerOrg: deps.a2a.providerOrg,
    providerUrl: deps.a2a.providerUrl,
    tokenUrl: deps.a2a.tokenUrl,
  };
  const a2aNotFound = (reply: FastifyReply, agentId: string): FastifyReply =>
    reply.status(404).send({
      error: { message: `no a2a card for agent ${agentId}`, status: 404 },
    });

  // Index of exposed agents with an ACTIVE version — the catalog the gateway
  // serves at /.well-known/agent.json. Card URLs point at the public edge.
  app.get('/v1/a2a-cards', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const agents: { agent_id: string; card_url: string }[] = [];
    for (const agentId of [...deps.a2a.exposure].sort()) {
      const versions = await deps.store.listVersions(agentId);
      if (!versions.some((v) => v.lifecycle_state === 'active')) continue;
      agents.push({
        agent_id: agentId,
        card_url: `${deps.a2a.edgeBaseUrl.replace(/\/$/, '')}/v1/a2a/agents/${agentId}/.well-known/agent.json`,
      });
    }
    return { agents };
  });

  // Per-agent card: resolves the ACTIVE version (an agent with no active
  // version exports nothing — same 404).
  app.get('/v1/agents/:agent_id/a2a-card', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { agent_id } = request.params as { agent_id: string };
    if (!deps.a2a.exposure.has(agent_id)) return a2aNotFound(reply, agent_id);
    const versions = await deps.store.listVersions(agent_id);
    const active = versions.find((v) => v.lifecycle_state === 'active');
    if (active === undefined) return a2aNotFound(reply, agent_id);
    return reply.send(await signA2ACard(deps.signingKey, toA2ACard(active, a2aOptions)));
  });

  // Version-pinned card export (still exposure-gated; the same 404 shape for
  // non-exposed, unknown agent, and unknown version).
  app.get('/v1/agents/:agent_id/versions/:version/a2a-card', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { agent_id, version } = request.params as { agent_id: string; version: string };
    if (!deps.a2a.exposure.has(agent_id)) return a2aNotFound(reply, agent_id);
    const card = await deps.store.getVersion(agent_id, version);
    if (card === undefined) return a2aNotFound(reply, agent_id);
    return reply.send(await signA2ACard(deps.signingKey, toA2ACard(card, a2aOptions)));
  });

  // Version-aware routing view for a capability (the Deployment Controller's
  // resolveRoute reads this): the incumbent active card and any candidate.
  app.get('/v1/routing', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const query = request.query as { capability?: string };
    if (query.capability === undefined || query.capability === '') {
      throw new AuthError('capability query parameter is required', 400);
    }
    return reply.send(await deps.store.routingSet(query.capability));
  });

  // --- MCP tool-server catalog (SF3). INTERNAL only: these records name scope
  // vocabulary, SoR topology, and credential KEY NAMES, so reads require
  // registry:read and publishes require registry:admin. The catalog is NEVER
  // served on the public A2A edge. Secrets are never stored — auth.credential_ref
  // is an env/vault key name the tool gateway expands at call time.

  app.get('/v1/tool-servers', async (request) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    return { tool_servers: await deps.toolServers.list() };
  });

  app.get('/v1/tool-servers/:id', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:read');
    const { id } = request.params as { id: string };
    const record = await deps.toolServers.get(id);
    if (record === undefined) {
      return reply
        .status(404)
        .send({ error: { message: `no tool server with id ${id}`, status: 404 } });
    }
    return reply.send(record);
  });

  app.put('/v1/tool-servers/:id', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:admin');
    const { id } = request.params as { id: string };
    let record: ToolServerRecord;
    try {
      record = toolServerRecord.parse(request.body);
    } catch (err) {
      if (err instanceof ProtocolValidationError) throw new AuthError(err.message, 400);
      throw err;
    }
    if (record.id !== id) {
      throw new AuthError(`tool server record id ${record.id} does not match path ${id}`, 400);
    }
    const result = await deps.toolServers.put(record);
    const deprecated = record.deprecation?.deprecated === true;
    await deps.audit.publish({
      event_id: randomUUID(),
      occurred_at: now().toISOString(),
      tenant: 'platform',
      event_type: deprecated ? 'tool_server.deprecated' : 'tool_server.published',
      actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
      action: { name: deprecated ? 'tool_server.deprecated' : 'tool_server.published' },
      details: { tool_server: id, version: record.version, outcome: result.outcome },
    });
    return reply.status(result.outcome === 'inserted' ? 201 : 200).send(record);
  });

  app.put('/v1/agents/:agent_id/baseline', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:write');
    const { agent_id } = request.params as { agent_id: string };

    let baseline: EvalBaseline;
    try {
      baseline = evalBaseline.parse(request.body);
    } catch (err) {
      if (err instanceof ProtocolValidationError) throw new AuthError(err.message, 400);
      throw err;
    }
    if (baseline.agent_id !== agent_id) {
      throw new AuthError(`baseline agent_id ${baseline.agent_id} does not match ${agent_id}`, 400);
    }
    // Version-aware (debt #3): the baseline lands on ITS OWN version's row, so a
    // candidate's baseline never clobbers the incumbent's (the incumbent's
    // eval_baseline is now load-bearing for gates).
    const card = await deps.store.getVersion(agent_id, baseline.agent_version);
    if (card === undefined) {
      return reply.status(404).send({
        error: {
          message: `no version ${baseline.agent_version} of agent ${agent_id} to attach a baseline to`,
          status: 404,
        },
      });
    }

    const updated = await deps.store.putBaseline(agent_id, baseline.agent_version, baseline);
    await deps.announcer.announce('updated', updated);
    await emitAudit(deps, claims, 'agent.baseline_recorded', updated, {
      agent_version: baseline.agent_version,
      suite_digest: baseline.suite.digest,
      metrics: baseline.metrics,
    });
    return reply.send(updated);
  });

  // --- Tier-2/3 kill-switch flip surface (capability / risk class / fleet) ---
  // Every flip is registry:admin, requires a reason, and flips the fast-path
  // control KV BEFORE emitting the killswitch.activated/cleared audit — so by
  // the time consumers see the event the flag already answers correctly (<10s
  // SLO). The agent tier keeps its own /state route; these are platform-wide.

  // Tier 2 (capability): suspend/reinstate a single capability by name. Blocks
  // even compensators (surgical intent wins — exemption matrix).
  app.post('/v1/killswitch/capability/:name', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:admin');
    const { name } = request.params as { name: string };
    if (!CAPABILITY_NAME_RE.test(name)) {
      throw new AuthError(
        `capability name ${JSON.stringify(name)} is not a valid capability (e.g. change.submit)`,
        400,
      );
    }
    const { active, reason } = parseFlipBody(request);
    if (active) {
      await deps.control.suspendCapability(name, reason, claims.sub);
    } else {
      await deps.control.reinstateCapability(name);
    }
    await emitKillSwitchAudit(deps, claims, active, 'capability', name, reason);
    return reply.status(202).send({ tier: 'capability', target: name, active });
  });

  // Tier 2 (risk class): suspend/reinstate a whole risk class. A flag on class C
  // blocks every executing risk with rank >= rank(C). R0 is refused (400) — a
  // read-only class is never worth flagging; halt the fleet instead.
  app.post('/v1/killswitch/risk/:class', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:admin');
    const { class: riskClass } = request.params as { class: string };
    if (!RISK_CLASS_TARGETS.has(riskClass)) {
      throw new AuthError(
        `risk class ${JSON.stringify(riskClass)} cannot be kill-switched — only R1, R2, R3 ` +
          '(R0 is read-only; halt the fleet instead)',
        400,
      );
    }
    const { active, reason } = parseFlipBody(request);
    if (active) {
      await deps.control.suspendRiskClass(riskClass, reason, claims.sub);
    } else {
      await deps.control.reinstateRiskClass(riskClass);
    }
    await emitKillSwitchAudit(deps, claims, active, 'risk', riskClass, reason);
    return reply.status(202).send({ tier: 'risk', target: riskClass, active });
  });

  // Tier 3 (fleet): halt/resume all task dispatch + intake. The gateway's fleet
  // auto-canceller reacts to the flip and drains in-flight TaskWorkflows.
  app.post('/v1/killswitch/fleet', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:admin');
    const { active, reason } = parseFlipBody(request);
    if (active) {
      await deps.control.haltFleet(reason, claims.sub);
    } else {
      await deps.control.resumeFleet();
    }
    await emitKillSwitchAudit(deps, claims, active, 'fleet', 'fleet', reason);
    return reply.status(202).send({ tier: 'fleet', active });
  });

  return app;
}

/** Parses and validates a kill-switch flip body: {active: boolean, reason: string (mandatory)}. */
function parseFlipBody(request: FastifyRequest): { active: boolean; reason: string } {
  const body = (request.body ?? {}) as { active?: unknown; reason?: unknown };
  if (typeof body.active !== 'boolean') {
    throw new AuthError('active (boolean) is required — true to suspend, false to reinstate', 400);
  }
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    throw new AuthError(
      'reason is required — it lands in the audit record and the control state',
      400,
    );
  }
  return { active: body.active, reason: body.reason };
}

/**
 * Emits the tier-2/3 kill-switch activation/clear audit. Platform-tenant
 * (killswitch is platform infrastructure), actor is the verified operator, and
 * details carry the open {tier, target, reason} vocabulary (no protocol touch).
 */
async function emitKillSwitchAudit(
  deps: RegistryDeps,
  claims: PlatformClaims,
  active: boolean,
  tier: 'capability' | 'risk' | 'fleet',
  target: string,
  reason: string,
): Promise<void> {
  await deps.audit.publish({
    event_id: randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    tenant: 'platform',
    event_type: active ? 'killswitch.activated' : 'killswitch.cleared',
    actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
    action: { name: active ? 'killswitch.activated' : 'killswitch.cleared' },
    details: { tier, target, reason },
  });
}

/** Options for a lifecycle transition shared by the legacy and versioned routes. */
interface TransitionRequest {
  target: LifecycleState | undefined;
  reason?: string | undefined;
  rampPercent?: number | undefined;
  allowedClasses: ScopeClass[];
}

/**
 * Drives one version across a transition-table edge: validates legality + scope
 * class + edge-specific rules (ramp for canary, baseline for shadow entry),
 * writes it (partial-index violations → 409), flips the kill-switch flag on
 * suspend/reinstate, then announces and audits.
 */
async function applyStateTransition(
  deps: RegistryDeps,
  now: () => Date,
  request: FastifyRequest,
  reply: FastifyReply,
  claims: PlatformClaims,
  card: AgentCard,
  req: TransitionRequest,
): Promise<FastifyReply> {
  const agentId = card.manifest.id;
  const version = card.version;
  const from = card.lifecycle_state;
  const target = req.target;
  const edge = target === undefined ? undefined : TRANSITIONS[from]?.[target];
  const legal = Object.keys(TRANSITIONS[from] ?? {});

  if (target === undefined || edge === undefined) {
    return reply.status(409).send({
      error: {
        message:
          `cannot transition ${agentId}@${version} from ${from} to ${String(target)} — ` +
          `legal: ${legal.join(', ') || 'none'} (canary→active and active→deprecated go via /promote)`,
        status: 409,
      },
    });
  }
  if (!req.allowedClasses.includes(edge)) {
    return reply.status(409).send({
      error: {
        message: `the ${from}→${target} edge is a ${edge} transition — not available on this route`,
        status: 409,
      },
    });
  }
  if (!SCOPE_FOR[edge].some((s) => scopesOf(claims).includes(s))) {
    return reply.status(403).send({
      error: {
        message: `principal ${claims.sub} lacks ${SCOPE_FOR[edge].join(' or ')} for a ${edge} transition`,
        status: 403,
      },
    });
  }

  // Edge-specific rules.
  let ramp: number | null | undefined;
  if (target === 'canary') {
    const p = req.rampPercent;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 100) {
      throw new AuthError('ramp_percent (integer 1-100) is required to enter canary', 400);
    }
    ramp = p;
  } else if (from === 'canary') {
    // Demotion / any exit from canary clears the ramp.
    ramp = null;
  }
  if (from === 'registered' && target === 'shadow' && card.eval_baseline === undefined) {
    return reply.status(409).send({
      error: {
        message:
          `${agentId}@${version} has no eval_baseline — record one (PUT /baseline) before shadow ` +
          'entry; gates are relative to it',
        status: 409,
      },
    });
  }

  let updated: AgentCard;
  try {
    updated = await deps.store.transition(agentId, version, target, {
      now: now().toISOString(),
      ...(ramp !== undefined ? { rampPercent: ramp } : {}),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
      // deployed_at is stamped when a version enters active (bootstrap /
      // reinstate here; the ramp path enters active only via /promote).
      ...(target === 'active' ? { setDeployedAt: true } : {}),
    });
  } catch (err) {
    if (err instanceof InvariantViolation) {
      return reply.status(409).send({ error: { message: err.message, status: 409 } });
    }
    throw err;
  }

  // Order matters for the kill switch: the fast-path flag flips before the
  // announcement, so by the time consumers see the event the flag already
  // answers correctly. Suspension is coarse (whole agent id, all versions) —
  // acceptable emergency control (documented).
  if (target === 'suspended') {
    await deps.announcer.setSuspended(
      agentId,
      true,
      req.reason ?? 'suspended via registry',
      claims.sub,
    );
  } else if (from === 'suspended') {
    await deps.announcer.setSuspended(agentId, false, req.reason ?? 'reinstated', claims.sub);
  }
  await deps.announcer.announce('updated', updated);
  await emitAudit(deps, claims, 'agent.lifecycle_changed', updated, {
    from,
    to: target,
    reason: req.reason ?? null,
    ...(ramp !== undefined && ramp !== null ? { ramp_to: ramp } : {}),
  });
  if (target === 'suspended' || from === 'suspended') {
    await emitAudit(
      deps,
      claims,
      target === 'suspended' ? 'killswitch.activated' : 'killswitch.cleared',
      updated,
      { tier: 'agent', agent_id: agentId, reason: req.reason ?? null },
    );
  }
  return reply.send(updated);
}

/**
 * Registration gates beyond schema validity. Rejections name the exact
 * capability and what to change — registration failures are developer UX.
 */
export function validateRegistrationRules(manifest: AgentManifest): void {
  const seen = new Set<string>();
  // Index capability risks up front so compensator references can be
  // validated against the manifest as a whole (cross-agent compensators are
  // unsupported v1; runtime discovery may still route the compensator to
  // another server, which is acceptable).
  const riskOf = new Map<string, string>();
  for (const cap of manifest.capabilities) {
    riskOf.set(cap.name, cap.risk);
  }

  for (const cap of manifest.capabilities) {
    if (seen.has(cap.name)) {
      throw new AuthError(`duplicate capability ${cap.name} in manifest ${manifest.id}`, 400);
    }
    seen.add(cap.name);

    const isWrite = cap.risk === 'R2' || cap.risk === 'R3';
    const hasCompensator = cap.compensator !== undefined;

    // Rule 1 (keep): an R2/R3 write must declare a reversibility posture —
    // a compensator OR an explicit irreversible flag.
    if (isWrite && !hasCompensator && cap.irreversible !== true) {
      throw new AuthError(
        `capability ${cap.name} is ${cap.risk} but declares no compensator — declare one ` +
          `(e.g. change.submit ⇄ change.withdraw) or mark it irreversible: true to accept ` +
          `stricter approval requirements (orchestration.md)`,
        400,
      );
    }

    // Rule 2: compensator and irreversible are contradictory — a write is
    // either reversible (names its compensator) or it is not (irreversible).
    if (hasCompensator && cap.irreversible === true) {
      throw new AuthError(
        `capability ${cap.name} declares both a compensator (${String(cap.compensator)}) and ` +
          `irreversible: true — these contradict: declare exactly one (a reversible write names ` +
          `its compensator; an irreversible write has none)`,
        400,
      );
    }

    // Rule 6: R0 (read) and R1 (draft) never mutate persistent state that a
    // compensator would undo, and irreversible only qualifies a write; an R0
    // must declare neither. (An R1 MAY declare a compensator — legal but the
    // saga ignores it; only R2+ writes are pushed onto the stack.)
    if (cap.risk === 'R0' && (hasCompensator || cap.irreversible === true)) {
      throw new AuthError(
        `capability ${cap.name} is R0 (read-only) but declares ` +
          `${hasCompensator ? 'a compensator' : 'irreversible: true'} — reversibility posture ` +
          `applies only to R1+ (a read has nothing to compensate)`,
        400,
      );
    }
    if (cap.risk === 'R1' && cap.irreversible === true) {
      throw new AuthError(
        `capability ${cap.name} is R1 (draft) but declares irreversible: true — the irreversible ` +
          `flag qualifies an R2+ write with no compensator; a draft has no persistent side effect`,
        400,
      );
    }

    const compensator = cap.compensator;
    if (compensator !== undefined) {
      // Rule 4: a capability may not name itself as its own compensator —
      // running the write again does not undo it.
      if (compensator === cap.name) {
        throw new AuthError(
          `capability ${cap.name} names itself as its compensator — a compensator must be a ` +
            `distinct capability that reverses the write`,
          400,
        );
      }
      // Rule 3: the compensator must be a capability in the same manifest
      // (dangling references cannot be dispatched by the saga).
      const compRisk = riskOf.get(compensator);
      if (compRisk === undefined) {
        throw new AuthError(
          `capability ${cap.name} names compensator ${compensator}, which is not a capability in ` +
            `manifest ${manifest.id} — declare the compensator in the same manifest (cross-agent ` +
            `compensators are unsupported)`,
          400,
        );
      }
      // Rule 5: the referenced compensator's own risk must be R1 or R2. An R0
      // cannot undo a write; an R3 is platform-disabled (auto-write, never a
      // safe unwind target).
      if (compRisk !== 'R1' && compRisk !== 'R2') {
        throw new AuthError(
          `capability ${cap.name} names compensator ${compensator}, which is ${compRisk} — a ` +
            `compensator must be R1 or R2 (an R0 read cannot reverse a write; R3 is not a safe ` +
            `unwind target)`,
          400,
        );
      }
    }
  }
}

async function emitAudit(
  deps: RegistryDeps,
  claims: PlatformClaims,
  eventType: AuditEvent['event_type'],
  card: AgentCard,
  details: Record<string, unknown>,
): Promise<void> {
  await deps.audit.publish({
    event_id: randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    // The registry is platform infrastructure; its records are not
    // tenant-scoped in v0 (announcements go out on acp.platform.*).
    tenant: 'platform',
    event_type: eventType,
    actor: { principal: claims.sub, delegation_chain: delegationChain(claims) },
    action: { name: eventType },
    artifacts: { agent_id: card.manifest.id, agent_version: card.version },
    details,
  });
}

async function authenticate(deps: RegistryDeps, request: FastifyRequest): Promise<PlatformClaims> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ') !== true) {
    throw new AuthError('missing Bearer token');
  }
  return deps.verifier.verify(header.slice('Bearer '.length), REGISTRY_AUDIENCE);
}

function requireScope(claims: PlatformClaims, scope: string): void {
  if (!scopesOf(claims).includes(scope)) {
    throw new AuthError(`principal ${claims.sub} lacks scope ${scope}`, 403);
  }
}
