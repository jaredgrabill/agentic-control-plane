import { createHash, randomUUID } from 'node:crypto';
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
import type { ResolvedPriceBook } from '@acp/cost-meter/pricing';
import { HashEmbedder } from '@acp/embedding';
import { GatewayClient } from '@acp/llm-client';
import { createJudge, loadDevCalibration, type Judge } from '@acp/judge';
import { decideJudgeSample, type OnlineEvalConfig, type ScoreIngest } from '@acp/online-eval';
import { RULE_PLANNER, buildPlanSteps } from './planner.js';
import { checkProbe } from './probe-checks.js';
import { GateEvaluator, type GateReport } from './deployment-gates.js';
import type {
  ControlActivities,
  DeploymentPreflight,
  JudgeScoreInput,
  KillSwitchVerdict,
  PrincipalSnapshot,
} from './types.js';

/**
 * The read side of the kill switch the worker's checkKillSwitch activity needs
 * (structurally service-kit's KillSwitchWatcher). Each method returns a truthy
 * state only when the flag is ACTIVE. Injectable so unit tests stub it.
 */
export interface KillSwitchReader {
  fleetHalt(): { reason?: string } | undefined;
  agentSuspension(agentId: string): { reason?: string } | undefined;
  capabilitySuspension(name: string): { reason?: string } | undefined;
  riskClassSuspension(risk: string): { reason?: string } | undefined;
}

export interface ControlDeps {
  registryUrl: string;
  policyUrl: string;
  tokenUrl: string;
  /** Audit query base URL (the Deployment Controller's gate evaluator pages it). */
  auditUrl?: string;
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
  /** LLM gateway base URL — the calibrated judge's completion endpoint (item 6). */
  llmGatewayUrl?: string;
  /** Evaluation service base URL — the scores store the judge POSTs to (item 6). */
  evaluationUrl?: string;
  /** Synthetic-prober credentials (item 6): its own client_creds identity (svc-prober). */
  proberClientId?: string;
  proberClientSecret?: string;
  /** Scope string the probe subject token requests (the probed agents' tool scopes). */
  proberScope?: string;
  /**
   * Online-eval config (item 6): per-step sample rates + judge rubric/model
   * class. Absent in unit tests that do not exercise judged scoring.
   */
  onlineEval?: OnlineEvalConfig;
  /**
   * The worker's kill-switch watcher (item 5). Absent in unit tests that do
   * not exercise checkKillSwitch — the activity then answers "not halted".
   */
  killSwitch?: KillSwitchReader;
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

  // --- Online-eval judge scoring (item 6) ---------------------------------
  let judge: Judge | undefined;
  function getJudge(): Judge {
    judge ??= createJudge({
      gateway: new GatewayClient({ url: deps.llmGatewayUrl ?? '', fetchImpl: doFetch }),
      tokenProvider: () => serviceToken('acp:llm', 'llm:invoke'),
      calibration: loadDevCalibration(),
      rubricId: deps.onlineEval?.judge.rubric ?? 'answer-quality@1',
      modelClass: deps.onlineEval?.judge.model_class ?? 'default-tier',
      minAgreement: deps.onlineEval?.judge.min_agreement ?? 0.85,
    });
    return judge;
  }

  async function postScore(ingest: ScoreIngest): Promise<void> {
    const token = await serviceToken('acp:eval', 'eval:write');
    const res = await doFetch(`${deps.evaluationUrl ?? ''}/v1/scores`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(ingest),
    });
    if (!res.ok) {
      throw new Error(`score ingest failed: ${res.status} ${await res.text()}`);
    }
  }

  async function runJudgeScore(input: JudgeScoreInput): Promise<void> {
    const inputText = deriveText(input.input, ['question', 'query', 'text']);
    const scoreId = deterministicUuid(`${input.task_id}:${input.step_id}:${input.route}`);
    const artifacts = {
      agent_id: input.agent_id,
      agent_version: input.agent_version,
    };
    const reason = { task_id: input.task_id, step_id: input.step_id };

    // A hard step failure is a quality observation (passed:false) — no LLM call.
    if (input.status === 'failed' || input.output === null) {
      await postScore({
        id: scoreId,
        agent_id: input.agent_id,
        agent_version: input.agent_version,
        capability: input.capability,
        tenant: input.tenant,
        task_id: input.task_id,
        step_id: input.step_id,
        source: 'judge',
        route: input.route,
        score: null,
        passed: false,
        weight: 1,
        outcome: 'failed_step',
      });
      await emitEvalScore(deps, {
        tenant: input.tenant,
        artifacts,
        reason,
        rubricName: deps.onlineEval?.judge.rubric ?? 'answer-quality@1',
        inputsDigest: sha256Digest(inputText),
        details: { route: input.route, outcome: 'failed_step' },
      });
      return;
    }

    const outputText = deriveText(input.output, ['text', 'answer']);
    const citations = extractCitations(input.output);
    const result = await getJudge().score({ input: inputText, output: outputText, citations });

    // Only a genuine judged verdict is a quality observation. uncalibrated /
    // judge_error / unparseable_verdict are JUDGE conditions — audit them for
    // observability, but INGEST NOTHING (no error-budget burn).
    if (result.outcome === 'scored' && result.score !== undefined) {
      await postScore({
        id: scoreId,
        agent_id: input.agent_id,
        agent_version: input.agent_version,
        capability: input.capability,
        tenant: input.tenant,
        task_id: input.task_id,
        step_id: input.step_id,
        source: 'judge',
        route: input.route,
        score: result.score,
        passed: null,
        weight: 1,
        rubric: result.rubric,
        rubric_digest: result.rubric_digest,
        ...(result.model !== undefined ? { model: result.model } : {}),
        outcome: 'scored',
        input_embedding: new HashEmbedder().embed(inputText),
      });
    }
    await emitEvalScore(deps, {
      tenant: input.tenant,
      artifacts: { ...artifacts, ...(result.model !== undefined ? { model: result.model } : {}) },
      reason,
      rubricName: result.rubric,
      inputsDigest: sha256Digest(inputText),
      ...(result.verdict !== undefined
        ? { outputsDigest: sha256Digest(stableStringify(result.verdict)) }
        : {}),
      details: {
        rubric: result.rubric,
        rubric_digest: result.rubric_digest,
        model_class: result.model_class,
        route: input.route,
        outcome: result.outcome,
        ...(result.score !== undefined ? { score: result.score } : {}),
        ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
        ...(result.calibration !== undefined ? { calibration: result.calibration } : {}),
      },
    });
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

      // A shadow soak boosts the primary (incumbent) to always-judged, so the
      // incumbent's score pairs with the shadow candidate's for the gate.
      const boost = set.shadow !== undefined;
      const sample = (agentId: string): boolean =>
        deps.onlineEval === undefined || input.stepId === undefined
          ? false
          : decideJudgeSample(deps.onlineEval.sample, {
              taskId: input.taskId,
              stepId: input.stepId,
              agentId,
              boost,
            }).selected;

      // Canary session pinning: this task's bucket falls under the ramp → the
      // whole task runs the candidate; otherwise the incumbent.
      if (set.canary !== undefined && bucket < set.canary.ramp_percent) {
        return {
          card: set.canary.card,
          route: 'canary',
          rampPercent: set.canary.ramp_percent,
          bucket,
          judge_sample: sample(set.canary.card.manifest.id),
        };
      }
      if (set.active === undefined) return null;
      return {
        card: set.active,
        route: 'active',
        bucket,
        judge_sample: sample(set.active.manifest.id),
        // A shadow candidate (shadow soak only — an agent has at most one
        // shadow-or-canary) is mirrored; the primary still runs the incumbent.
        ...(set.shadow === undefined ? {} : { shadowCard: set.shadow }),
      };
    },

    async scoreWithJudge(input): Promise<void> {
      // Alarm-continue: a scoring failure (judge, embedding, POST, audit) must
      // never disturb the abandoned JudgeScoreWorkflow or — via the shadow
      // path — the primary step. Temporal's ≤3 retries are a safety net; the
      // activity itself swallows everything.
      try {
        await runJudgeScore(input);
      } catch (err) {
        deps.logger.warn(
          { err, task_id: input.task_id, step_id: input.step_id },
          'scoreWithJudge failed — alarm-continue (no quality observation recorded)',
        );
      }
    },

    async mintProbeSubject(): Promise<{ token: string; principal: string }> {
      const res = await doFetch(`${deps.tokenUrl}/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: deps.proberClientId ?? 'svc-prober',
          client_secret: deps.proberClientSecret ?? '',
          audience: 'acp:gateway',
          scope: deps.proberScope ?? 'task:submit knowledge:search:read',
        }),
      });
      if (!res.ok) {
        throw new Error(`probe subject mint failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { access_token: string; principal?: string };
      // The token's sub is the prober principal; the token service echoes it.
      return { token: body.access_token, principal: body.principal ?? 'svc:prober' };
    },

    async recordProbeResult(input): Promise<{ passed: boolean }> {
      const check = checkProbe(input.answer, input.expect);

      // Resolve the active serving version + owner so the score/audit attribute
      // to the version actually probed (probes hit ACTIVE only).
      let agentVersion = 'unknown';
      let owner = 'unknown';
      try {
        const token = await serviceToken('acp:registry', 'registry:read');
        const cardRes = await doFetch(
          `${deps.registryUrl}/v1/agents/${encodeURIComponent(input.agent_id)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (cardRes.ok) {
          const card = (await cardRes.json()) as AgentCard;
          agentVersion = card.version;
          owner = card.manifest.owner;
        }
      } catch {
        // best-effort attribution; a registry blip still records the result
      }

      try {
        const token = await serviceToken('acp:eval', 'eval:write');
        const scoreRes = await doFetch(`${deps.evaluationUrl ?? ''}/v1/scores`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            id: deterministicUuid(`${input.task_id}:${input.case_name}:probe`),
            agent_id: input.agent_id,
            agent_version: agentVersion,
            capability: input.capability,
            tenant: input.tenant,
            task_id: input.task_id,
            source: 'probe',
            route: 'probe',
            score: null,
            passed: check.passed,
            weight: input.weight,
            outcome: check.passed ? 'probe_pass' : 'probe_fail',
          } satisfies ScoreIngest),
        });
        if (!scoreRes.ok) {
          throw new Error(`probe score ingest failed: ${scoreRes.status} ${await scoreRes.text()}`);
        }
      } catch (err) {
        deps.logger.warn(
          { err, agent_id: input.agent_id },
          'probe score ingest failed (alarm-continue)',
        );
      }

      await deps.audit.publish({
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        tenant: input.tenant,
        event_type: 'eval.probe_result',
        actor: { principal: 'svc:prober', delegation_chain: [{ sub: 'svc:prober' }] },
        action: { name: 'probe:known-answer' },
        reason: { task_id: input.task_id },
        artifacts: { agent_id: input.agent_id, agent_version: agentVersion },
        details: {
          case: input.case_name,
          capability: input.capability,
          passed: check.passed,
          duration_ms: input.duration_ms,
          owner,
          checks: check.checks,
        },
      });
      return { passed: check.passed };
    },

    async listProbeTargets(input): Promise<{ uncovered: string[] }> {
      try {
        const token = await serviceToken('acp:registry', 'registry:read');
        const res = await doFetch(`${deps.registryUrl}/v1/agents?state=active`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return { uncovered: [] };
        const { agents } = (await res.json()) as { agents: AgentCard[] };
        const covered = new Set(input.covered);
        const uncovered = [...new Set(agents.map((a) => a.manifest.id))].filter(
          (id) => !covered.has(id),
        );
        if (uncovered.length > 0) {
          deps.logger.warn(
            { uncovered },
            'active agents without synthetic probe coverage — quality visibility is incomplete',
          );
        }
        return { uncovered };
      } catch (err) {
        deps.logger.warn({ err }, 'listProbeTargets failed');
        return { uncovered: [] };
      }
    },

    checkKillSwitch(input): Promise<KillSwitchVerdict> {
      const ks = deps.killSwitch;
      if (ks === undefined) return Promise.resolve({ halted: false });
      // Named capability and agent flags block EVEN a compensator (surgical
      // intent wins; design-2 test 7 expects an honest-incomplete unwind when
      // the compensator's only server is the suspended agent).
      const named = ks.capabilitySuspension(input.capability);
      if (named !== undefined) {
        return Promise.resolve({
          halted: true,
          tier: 'capability',
          target: input.capability,
          reason: named.reason ?? 'no reason recorded',
        });
      }
      const agent = ks.agentSuspension(input.agentId);
      if (agent !== undefined) {
        return Promise.resolve({
          halted: true,
          tier: 'agent',
          target: input.agentId,
          reason: agent.reason ?? 'no reason recorded',
        });
      }
      // Fleet and covering risk-class flags are EXEMPT for a compensator: a halt
      // must not make an in-flight write permanently un-compensable.
      if (!input.compensation) {
        const fleet = ks.fleetHalt();
        if (fleet !== undefined) {
          return Promise.resolve({
            halted: true,
            tier: 'fleet',
            target: 'fleet',
            reason: fleet.reason ?? 'no reason recorded',
          });
        }
        const risk = ks.riskClassSuspension(input.risk);
        if (risk !== undefined) {
          return Promise.resolve({
            halted: true,
            tier: 'risk',
            target: input.risk,
            reason: risk.reason ?? 'no reason recorded',
          });
        }
      }
      return Promise.resolve({ halted: false });
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

    now() {
      return Promise.resolve({ iso: new Date().toISOString() });
    },

    async beginDeployment(input): Promise<DeploymentPreflight> {
      const token = await serviceToken('acp:registry', 'registry:read');
      const headers = { authorization: `Bearer ${token}` };
      // The candidate must exist, be `registered`, and carry a matching baseline.
      const candRes = await doFetch(
        `${deps.registryUrl}/v1/agents/${encodeURIComponent(input.agentId)}` +
          `/versions/${encodeURIComponent(input.candidateVersion)}`,
        { headers },
      );
      if (candRes.status === 404) {
        throw ApplicationFailure.nonRetryable(
          `candidate ${input.agentId}@${input.candidateVersion} is not registered`,
        );
      }
      if (!candRes.ok) throw new Error(`candidate lookup failed: ${candRes.status}`);
      const candidate = (await candRes.json()) as AgentCard;
      if (candidate.lifecycle_state !== 'registered') {
        throw ApplicationFailure.nonRetryable(
          `candidate ${input.agentId}@${input.candidateVersion} is ${candidate.lifecycle_state}, ` +
            'not registered — a deployment starts from a freshly registered version',
        );
      }
      if (candidate.eval_baseline === undefined) {
        throw ApplicationFailure.nonRetryable(
          `candidate ${input.agentId}@${input.candidateVersion} has no eval_baseline — record one first`,
        );
      }
      const capabilities = candidate.manifest.capabilities.map((c) => c.name);
      const requiresApproval = candidate.manifest.capabilities.some(
        (c) => c.risk === 'R2' || c.risk === 'R3',
      );

      // The incumbent is the current active version (may be absent on a
      // first-ever deployment — the promote then simply activates the candidate).
      const activeRes = await doFetch(
        `${deps.registryUrl}/v1/agents?capability=${encodeURIComponent(capabilities[0] ?? '')}&state=active`,
        { headers },
      );
      let incumbentVersion: string | undefined;
      let baselineNote = 'no incumbent baseline to compare';
      if (activeRes.ok) {
        const { agents } = (await activeRes.json()) as { agents: AgentCard[] };
        const incumbent = agents.find((a) => a.manifest.id === input.agentId);
        if (incumbent !== undefined) {
          incumbentVersion = incumbent.version;
          const incDigest = incumbent.eval_baseline?.suite.digest;
          // candidate.eval_baseline is guaranteed present (guarded above).
          const candDigest = candidate.eval_baseline.suite.digest;
          baselineNote =
            incDigest !== undefined && incDigest === candDigest
              ? 'comparable_suite'
              : 'incomparable_suite';
        }
      }
      return {
        ...(incumbentVersion === undefined ? {} : { incumbentVersion }),
        capabilities,
        requiresApproval,
        baselineNote,
      };
    },

    async deployTransition(input): Promise<void> {
      const token = await serviceToken('acp:registry', 'registry:deploy');
      const res = await doFetch(
        `${deps.registryUrl}/v1/agents/${encodeURIComponent(input.agentId)}` +
          `/versions/${encodeURIComponent(input.version)}/state`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            state: input.state,
            ...(input.rampPercent === undefined ? {} : { ramp_percent: input.rampPercent }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `deploy transition ${input.agentId}@${input.version}→${input.state} failed: ` +
            `${res.status} ${await res.text()}`,
        );
      }
    },

    async promoteVersion(input): Promise<void> {
      const token = await serviceToken('acp:registry', 'registry:deploy');
      const res = await doFetch(
        `${deps.registryUrl}/v1/agents/${encodeURIComponent(input.agentId)}/promote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ version: input.version }),
        },
      );
      if (!res.ok) {
        throw new Error(`promote ${input.agentId}@${input.version} failed: ${res.status}`);
      }
    },

    async evaluateGate(input): Promise<GateReport> {
      const auditUrl = deps.auditUrl;
      if (auditUrl === undefined) {
        throw new Error('ACP_AUDIT_URL is not configured — the deployment gate cannot query audit');
      }
      const token = await serviceToken('acp:audit', 'audit:read');
      // Page the audit window (limit=1000) from the soak start.
      const events: AuditEvent[] = [];
      let since = input.since;
      for (let page = 0; page < 20; page += 1) {
        const res = await doFetch(
          `${auditUrl}/v1/events?tenant=${encodeURIComponent(input.tenant)}` +
            `&since=${encodeURIComponent(since)}&limit=1000`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          // A gate that cannot measure must not pass — fail closed by throwing
          // (Temporal retries; a persistent failure fails the deployment).
          throw new Error(`gate audit query failed: ${res.status} ${await res.text()}`);
        }
        const { events: batch } = (await res.json()) as { events: AuditEvent[] };
        events.push(...batch);
        if (batch.length < 1000) break;
        const last = batch[batch.length - 1];
        if (last === undefined) break;
        since = last.occurred_at;
      }

      let book: ResolvedPriceBook | undefined;
      try {
        book = loadResolvedPriceBook({ path: deps.priceBookPath });
      } catch {
        book = undefined;
      }
      const evaluator = new GateEvaluator();
      return input.kind === 'shadow'
        ? evaluator.evaluateShadow(events, { thresholds: input.thresholds, priceBook: book })
        : evaluator.evaluateCanary(events, {
            candidateVersion: input.candidateVersion,
            incumbentVersion: input.incumbentVersion ?? '',
            thresholds: input.thresholds,
            priceBook: book,
          });
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

// --- Online-eval judge scoring helpers (item 6) ----------------------------

/** Pulls a text field from a step's input/output record, else stringifies it. */
function deriveText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return JSON.stringify(record);
}

/** Renders an Answer envelope's citations for the judge (doc_id + snippet). */
function extractCitations(output: Record<string, unknown> | null): string[] {
  if (output === null) return [];
  const citations = output.citations;
  if (!Array.isArray(citations)) return [];
  return citations.map((c) => {
    if (typeof c !== 'object' || c === null) return String(c);
    const { doc_id, snippet } = c as { doc_id?: unknown; snippet?: unknown };
    const id = typeof doc_id === 'string' ? doc_id : 'unknown';
    return typeof snippet === 'string' ? `${id}: ${snippet}` : id;
  });
}

/** A uuid-shaped idempotency key derived from a stable seed (retries dedupe). */
function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface EvalScoreParams {
  tenant: string;
  artifacts: { agent_id: string; agent_version: string; model?: string };
  reason: { task_id: string; step_id: string };
  rubricName: string;
  inputsDigest: string;
  outputsDigest?: string;
  details: Record<string, unknown>;
}

/** Emits an eval.score audit (R0 alarm-continue; digests only, never the raw text). */
async function emitEvalScore(deps: ControlDeps, params: EvalScoreParams): Promise<void> {
  await deps.audit.publish({
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    tenant: params.tenant,
    event_type: 'eval.score',
    actor: {
      principal: 'svc:orchestrator',
      delegation_chain: [{ sub: 'svc:orchestrator' }],
    },
    action: {
      name: `judge:${params.rubricName}`,
      inputs_digest: params.inputsDigest,
      ...(params.outputsDigest !== undefined ? { outputs_digest: params.outputsDigest } : {}),
    },
    reason: params.reason,
    artifacts: params.artifacts,
    details: params.details,
  });
}
