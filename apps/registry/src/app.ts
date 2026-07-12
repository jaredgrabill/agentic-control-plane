import { randomUUID } from 'node:crypto';
import {
  agentCard,
  agentManifest,
  evalBaseline,
  ProtocolValidationError,
  type AgentCard,
  type AgentManifest,
  type AuditEvent,
  type EvalBaseline,
  type LifecycleState,
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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JSONWebKeySet, CryptoKey } from 'jose';
import { signCard } from './signing.js';
import type { AgentFilter, RegistryStore } from './store.js';

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

export interface RegistryDeps {
  verifier: JwtVerifier;
  store: RegistryStore;
  signingKey: { kid: string; privateKey: CryptoKey };
  jwks: JSONWebKeySet;
  announcer: RegistryAnnouncer;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

/** v0 vocabulary: the remaining lifecycle states arrive with the Deployment Controller. */
const V0_TRANSITIONS: Record<string, LifecycleState[]> = {
  registered: ['active', 'retired'],
  active: ['suspended'],
  // agent-lifecycle.md sends suspended agents back through shadow to
  // re-earn trust; until shadow exists (Phase 3), reinstatement goes
  // straight to active by explicit admin action.
  suspended: ['active', 'retired'],
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

    await deps.store.put(card);
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

  app.post('/v1/agents/:agent_id/state', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:admin');
    const { agent_id } = request.params as { agent_id: string };
    const body = (request.body ?? {}) as { state?: string; reason?: string };

    const card = await deps.store.get(agent_id);
    if (card === undefined) {
      return reply
        .status(404)
        .send({ error: { message: `no agent registered with id ${agent_id}`, status: 404 } });
    }
    const target = body.state as LifecycleState | undefined;
    const allowed = V0_TRANSITIONS[card.lifecycle_state] ?? [];
    if (target === undefined || !allowed.includes(target)) {
      throw new AuthError(
        `cannot transition ${agent_id} from ${card.lifecycle_state} to ${String(target)} — v0 allows: ${allowed.join(', ') || 'none'}`,
        409,
      );
    }

    const previous = card.lifecycle_state;
    const updated: AgentCard = {
      ...card,
      lifecycle_state: target,
      updated_at: now().toISOString(),
      ...(body.reason !== undefined ? { state_reason: body.reason } : {}),
    };
    await deps.store.put(updated);

    // Order matters for the kill switch: the fast-path flag flips before
    // the announcement, so by the time consumers see the event the flag
    // already answers correctly.
    if (target === 'suspended') {
      await deps.announcer.setSuspended(
        agent_id,
        true,
        body.reason ?? 'suspended via registry',
        claims.sub,
      );
    } else if (previous === 'suspended') {
      await deps.announcer.setSuspended(agent_id, false, body.reason ?? 'reinstated', claims.sub);
    }
    await deps.announcer.announce('updated', updated);
    await emitAudit(deps, claims, 'agent.lifecycle_changed', updated, {
      from: previous,
      to: target,
      reason: body.reason ?? null,
    });
    if (target === 'suspended' || previous === 'suspended') {
      await emitAudit(
        deps,
        claims,
        target === 'suspended' ? 'killswitch.activated' : 'killswitch.cleared',
        updated,
        { tier: 'agent', agent_id, reason: body.reason ?? null },
      );
    }
    return reply.send(updated);
  });

  app.put('/v1/agents/:agent_id/baseline', async (request, reply) => {
    const claims = await authenticate(deps, request);
    requireScope(claims, 'registry:write');
    const { agent_id } = request.params as { agent_id: string };

    const card = await deps.store.get(agent_id);
    if (card === undefined) {
      return reply
        .status(404)
        .send({ error: { message: `no agent registered with id ${agent_id}`, status: 404 } });
    }

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
    if (baseline.agent_version !== card.version) {
      throw new AuthError(
        `baseline is for version ${baseline.agent_version} but the registered card is ` +
          `${card.version} — re-run the suite against the registered contract`,
        409,
      );
    }

    // Merge in the app layer: the store replaces whole cards, and the
    // signature covers {manifest, version, registered_at} only, so the
    // baseline never invalidates it. Last-writer-wins is acceptable in v0 —
    // CI is the sole writer.
    const updated: AgentCard = {
      ...card,
      eval_baseline: baseline,
      updated_at: now().toISOString(),
    };
    await deps.store.put(updated);
    await deps.announcer.announce('updated', updated);
    await emitAudit(deps, claims, 'agent.baseline_recorded', updated, {
      agent_version: baseline.agent_version,
      suite_digest: baseline.suite.digest,
      metrics: baseline.metrics,
    });
    return reply.send(updated);
  });

  return app;
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
