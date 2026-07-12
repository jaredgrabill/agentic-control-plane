import { randomUUID } from 'node:crypto';
import {
  auditEvent as auditEventParser,
  plan as planParser,
  type AgentCard,
  type AuditEvent,
  type PlanStep,
} from '@acp/protocol';
import {
  scopesOf,
  sha256Digest,
  stableStringify,
  type AuditPublisher,
  type Logger,
  type PlatformClaims,
} from '@acp/service-kit';
import { ApplicationFailure } from '@temporalio/common';
import { loadResolvedPriceBook } from '@acp/cost-meter';
import { RULE_PLANNER, buildPlanSteps } from './planner.js';
import type { ControlActivities, PrincipalSnapshot } from './types.js';

export interface ControlDeps {
  registryUrl: string;
  policyUrl: string;
  tokenUrl: string;
  /** client_credentials for the orchestrator's own platform identity. */
  clientId: string;
  clientSecret: string;
  /** Verifies the forwarded subject token ONCE at intake (ADR-0007). */
  verifier: { verify(token: string, audience: string): Promise<PlatformClaims> };
  audit: AuditPublisher | { publish(event: AuditEvent): Promise<void> };
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Absolute path to the current price book (Cost Meter); default packaged book. */
  priceBookPath: string;
}

/**
 * Control-plane activities: every effectful step the workflows need.
 * Failures throw with operator-actionable messages; Temporal owns retries.
 */
export function createControlActivities(deps: ControlDeps): ControlActivities {
  const doFetch = deps.fetchImpl ?? fetch;

  /** Service token for calling other control-plane services, fetched per call (≤15min TTL). */
  async function serviceToken(audience: string, scope: string): Promise<string> {
    const res = await doFetch(`${deps.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        audience,
        scope,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `token service refused client_credentials for ${audience}: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  return {
    async snapshotPrincipal(input): Promise<PrincipalSnapshot> {
      // The ONE place the subject token is read (ADR-0007). Verification
      // failures are nonRetryable: a bad token will not get better.
      let claims: PlatformClaims;
      try {
        claims = await deps.verifier.verify(input.subjectToken, 'acp:gateway');
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `subject token failed intake verification: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (claims.sub !== input.expectedPrincipal || claims.tenant !== input.expectedTenant) {
        throw ApplicationFailure.nonRetryable(
          `subject token does not match the task attribution: token is for ` +
            `${claims.sub}@${claims.tenant}, task claims ${input.expectedPrincipal}@${input.expectedTenant} — ` +
            'the gateway stamps attribution from the same token, so this indicates tampering',
        );
      }
      return {
        sub: claims.sub,
        tenant: claims.tenant,
        roles: claims.roles,
        scopes: scopesOf(claims),
        ...(typeof claims.jti === 'string' ? { jti: claims.jti } : {}),
        verified_at: new Date().toISOString(),
      };
    },

    async planTask(task) {
      // The rule planner routes against what the fleet can actually serve
      // right now; suspension still gates each step at dispatch time.
      const token = await serviceToken('acp:registry', 'registry:read');
      const res = await doFetch(`${deps.registryUrl}/v1/agents?state=active`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`registry listing for planning failed: ${res.status} ${await res.text()}`);
      }
      const { agents } = (await res.json()) as { agents: AgentCard[] };
      const servable = new Set(agents.flatMap((a) => a.manifest.capabilities.map((c) => c.name)));

      const specs = buildPlanSteps(task, servable);
      const stepIds = specs.map(() => randomUUID());
      const idAt = (index: number): string => {
        const id = stepIds[index];
        if (id === undefined) {
          throw new Error(`plan step dependency index ${index} is out of range`);
        }
        return id;
      };
      const steps: PlanStep[] = specs.map((spec, i) => ({
        step_id: idAt(i),
        capability: spec.capability,
        input: spec.input,
        ...(spec.dependsOnIndex === undefined ? {} : { depends_on: spec.dependsOnIndex.map(idAt) }),
        ...(spec.rationale === undefined ? {} : { rationale: spec.rationale }),
      }));

      // The same schema gate a future LLM planner must clear — validation
      // is the seam, not the planner implementation.
      const plan = planParser.parse({
        plan_id: randomUUID(),
        task_id: task.task_id,
        tenant: task.tenant,
        planner: RULE_PLANNER,
        steps,
        created_at: new Date().toISOString(),
      });
      return { plan, planDigest: sha256Digest(JSON.stringify(plan)) };
    },

    async discoverAgent(capability, tenant): Promise<AgentCard | null> {
      const token = await serviceToken('acp:registry', 'registry:read');
      const res = await doFetch(
        `${deps.registryUrl}/v1/agents?capability=${encodeURIComponent(capability)}&state=active`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        throw new Error(`registry discovery failed: ${res.status} ${await res.text()}`);
      }
      const { agents } = (await res.json()) as { agents: AgentCard[] };
      // v0 selection: first active match. Weighted/semantic ranking is
      // Phase 2 (Discovery v1). Tenant visibility is a policy question the
      // authorizeDelegation step settles; the registry is platform-scoped.
      void tenant;
      return agents[0] ?? null;
    },

    async resolveRoute(input) {
      const token = await serviceToken('acp:registry', 'registry:read');
      // Deterministic session bucket: the same for every step of a task, so a
      // whole task pins to one version end-to-end (session pinning). Monotonic
      // ramp keeps a canary task canary; a rollback (ramp DOWN) re-routes the
      // vacated bucket to the incumbent mid-task — the point of a rollback.
      const bucket = parseInt(sha256Digest(input.taskId).slice('sha256:'.length, 15), 16) % 100;

      // A pinned dispatch (a compensator) routes to EXACTLY the version that did
      // the original write, and is NEVER shadow-mirrored.
      if (input.pin !== undefined) {
        const res = await doFetch(
          `${deps.registryUrl}/v1/agents/${encodeURIComponent(input.pin.agentId)}` +
            `/versions/${encodeURIComponent(input.pin.version)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`route pin lookup failed: ${res.status} ${await res.text()}`);
        const card = (await res.json()) as AgentCard;
        return { card, route: 'pinned', bucket };
      }

      const res = await doFetch(
        `${deps.registryUrl}/v1/routing?capability=${encodeURIComponent(input.capability)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`routing lookup failed: ${res.status} ${await res.text()}`);
      const set = (await res.json()) as {
        active?: AgentCard;
        canary?: { card: AgentCard; ramp_percent: number };
        shadow?: AgentCard;
      };

      // Canary session pinning: this task's bucket falls under the ramp → the
      // whole task runs the candidate; otherwise the incumbent.
      if (set.canary !== undefined && bucket < set.canary.ramp_percent) {
        return {
          card: set.canary.card,
          route: 'canary',
          rampPercent: set.canary.ramp_percent,
          bucket,
        };
      }
      if (set.active === undefined) return null;
      return {
        card: set.active,
        route: 'active',
        bucket,
        // A shadow candidate (shadow soak only — an agent has at most one
        // shadow-or-canary) is mirrored; the primary still runs the incumbent.
        ...(set.shadow === undefined ? {} : { shadowCard: set.shadow }),
      };
    },

    async authorizeDelegation(input) {
      // The principal's scopes come from the intake snapshot — verified
      // once, while fresh (ADR-0007) — never the manifest's wishlist.
      const token = await serviceToken('acp:policy', 'policy:decide');
      const capability = input.agent.manifest.capabilities.find((c) => c.name === input.capability);
      const res = await doFetch(`${deps.policyUrl}/v1/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          principal: {
            type: input.principal.startsWith('agent:') ? 'Agent' : 'User',
            id: input.principal,
            attrs: { tenant: input.tenant },
          },
          action: 'delegate',
          resource: {
            type: 'Agent',
            id: input.agent.manifest.id,
            attrs: { tenant: input.tenant },
          },
          context: {
            risk: capability?.risk ?? 'R3',
            scopes: input.snapshot.scopes,
            requested_scopes: input.requestedScopes,
            tenant: input.tenant,
            capability: input.capability,
            // Compensator dispatch: permit-compensation decides (not the R2
            // gate), so the unwind is never re-suspended on a human approval.
            ...(input.compensation === undefined
              ? {}
              : {
                  compensation: {
                    active: true,
                    original_step_id: input.compensation.originalStepId,
                    original_capability: input.compensation.originalCapability,
                  },
                }),
          },
          reason: { task_id: input.taskId, step_id: input.stepId, tenant: input.tenant },
        }),
      });
      if (!res.ok) {
        throw new Error(`policy service failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as Awaited<ReturnType<ControlActivities['authorizeDelegation']>>;
    },

    async brokerToken(input) {
      // ADR-0007: mint the step's token at dispatch time from the intake
      // snapshot. No subject token changes hands; the grounds join the mint
      // to the intake verification for auditors.
      const audience = `acp:agent:${input.agent.manifest.id}`;
      const res = await doFetch(`${deps.tokenUrl}/v1/token/delegate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:acp:oauth:grant-type:broker-delegation',
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          subject: {
            sub: input.snapshot.sub,
            tenant: input.snapshot.tenant,
            roles: input.snapshot.roles,
            scopes: input.snapshot.scopes,
          },
          audience,
          scope: input.scopes.join(' '),
          actor: `agent:${input.agent.manifest.id}@${input.agent.version}`,
          grounds: {
            task_id: input.taskId,
            ...(input.snapshot.jti === undefined ? {} : { subject_jti: input.snapshot.jti }),
            verified_at: input.snapshot.verified_at,
          },
          // Signed approval grounds — present only when the step passed an
          // approval gate. The token service shape-validates and refuses
          // self-approval before it signs the claim.
          ...(input.approval === undefined ? {} : { approval: input.approval }),
          // Signed compensation grounds — present only for a compensator
          // dispatched during a saga unwind. The token service refuses an
          // approval+compensation contradiction before it signs.
          ...(input.compensation === undefined ? {} : { compensation: input.compensation }),
          // Signed capability grounds — the executing capability + declared
          // risk, on every mint. The tool gateway enforces risk classes from
          // this claim; the token service shape-validates name + risk.
          ...(input.capability === undefined ? {} : { capability: input.capability }),
          // Signed deployment grounds — present ONLY for a shadow step token.
          // The token service shape-validates the mode; the tool gateway
          // suppresses side effects for it.
          ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
        }),
      });
      if (!res.ok) {
        throw new Error(
          `broker delegation for ${audience} failed: ${res.status} ${await res.text()}`,
        );
      }
      return { token: ((await res.json()) as { access_token: string }).access_token };
    },

    digestApprovalSubject(subject) {
      // sha256 over the canonical (key-sorted) subject — the isolate has no
      // crypto, so this must run activity-side. The digest binds the exact
      // context the approver saw to the decision signal and the minted token.
      return Promise.resolve({ subject_digest: sha256Digest(stableStringify(subject)) });
    },

    async emitAudit(event) {
      await deps.audit.publish(auditEventParser.parse(event));
    },

    digestValue(value) {
      // sha256 over the canonical (key-sorted) value — the isolate has no
      // crypto. The shadow gate joins a candidate's output_digest to the
      // incumbent's for comparison.
      return Promise.resolve({ digest: sha256Digest(stableStringify(value)) });
    },

    getPriceBook() {
      // Load + validate + resolve to integer micros on the activity side, so
      // the workflow isolate only ever holds integer rates. A malformed or
      // missing book rejects here (the synchronous throw is turned into a
      // rejection); the workflow decides fail-closed vs. disable-recording
      // based on whether max_cost_usd is set.
      try {
        return Promise.resolve(loadResolvedPriceBook({ path: deps.priceBookPath }));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
