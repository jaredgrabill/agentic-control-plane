/**
 * The enforcement pipeline — every tools/call passes, in order:
 *
 *   (1) kill switch (fleet halt, agent suspension)
 *   (2) governed-tool lookup (config allowlist)
 *   (3) Cedar decision (deny → refused BEFORE any upstream contact)
 *   (3.5) structural risk-class check (R3 disabled; a tool whose risk exceeds
 *         the signed capability claim's risk is refused; every R2+ tool called
 *         without a capability context is refused) — defense-in-depth with the
 *         Cedar pair-policy: either alone blocks an unauthorized write
 *   (4) rate limit (after Cedar: denials never consume quota)
 *   (5) input validation against the upstream's advertised schema
 *   (6) credential brokering (static headers or per-call exchange)
 *   (7) forward to the upstream MCP server
 *   (8) response validation (must be a ToolEnvelope)
 *   (9) tool.called audit + OTel span
 *  (10) return the upstream result verbatim (partial/gaps pass through)
 *
 * Every refusal after authN is an MCP-level ToolEnvelope error — the
 * Item 3 client mapping fires unchanged. Audit events are emitted from
 * the Cedar step on (outcome ok | denied | rate_limited | error:*);
 * kill-switch and not-governed refusals precede the decision and carry
 * no policy reference to record. Audit is R0 alarm-and-continue; R1+
 * risk classes fail closed at this PEP in Phase 3.
 */

import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { AuditEvent } from '@acp/protocol';
import { delegationChain, sha256Digest, type Logger } from '@acp/service-kit';
import { fail, parseToolEnvelope, toCallToolResult, type ToolEnvelope } from '@acp/tool-client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Caller } from './caller.js';
import type { ToolServerConfig } from './config.js';
import type { Correlation, CredentialBroker } from './broker.js';
import type { PolicyClient, PolicyDecision } from './policy-client.js';
import type { RateLimiter } from './rate-limit.js';
import type { UpstreamPool } from './upstream.js';
import { ToolInputValidators } from './validate.js';

/** Structural slice of service-kit's KillSwitchWatcher — tests stub it. */
export interface KillSwitch {
  fleetHalt(): { active: boolean; reason?: string } | undefined;
  agentSuspension(agentId: string): { active: boolean; reason?: string } | undefined;
  /** Broker-time denylist backstop: revokes a specific user/service/agent principal. */
  principalDenied(sub: string): { active: boolean; reason?: string } | undefined;
}

export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

export interface CoreDeps {
  config: ToolServerConfig;
  upstreams: UpstreamPool;
  policy: PolicyClient;
  broker: CredentialBroker;
  limiter: RateLimiter;
  audit: AuditSink;
  killSwitch?: KillSwitch | undefined;
  logger: Logger;
  now?: (() => Date) | undefined;
}

type Outcome =
  | 'ok'
  | 'denied'
  | 'rate_limited'
  | `error:${'invalid_input' | 'upstream_auth' | 'unavailable' | 'not_found' | 'rate_limited' | 'malformed'}`;

const tracer = trace.getTracer('tool-gateway');

export class ToolGatewayCore {
  private readonly validators = new ToolInputValidators();

  constructor(private readonly deps: CoreDeps) {}

  /**
   * Progressive disclosure v1: the upstream's advertised tools ∩ the
   * governed allowlist, filtered to the tools whose required scope the
   * caller actually holds — an agent sees only what it could call.
   */
  async listTools(caller: Caller, serverId: string): Promise<Tool[]> {
    const entry = this.deps.config.servers.get(serverId);
    if (entry === undefined) return [];
    const upstream = await this.deps.upstreams.listTools(serverId);
    return upstream.filter((tool) => {
      const spec = entry.tools[tool.name];
      return spec !== undefined && caller.scopes.includes(spec.scope);
    });
  }

  async callTool(
    caller: Caller,
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    corr: Correlation,
  ): Promise<CallToolResult> {
    return tracer.startActiveSpan(`tool.call ${serverId}/${tool}`, async (span) => {
      span.setAttributes({
        'acp.tenant': caller.tenant,
        'acp.tool_server': serverId,
        'acp.tool': tool,
        'acp.principal': caller.principal,
      });
      try {
        const { result, outcome, decision } = await this.execute(
          caller,
          serverId,
          tool,
          args,
          corr,
        );
        span.setAttributes({
          'acp.outcome': outcome,
          ...(decision !== undefined ? { 'acp.policy_decision': decision.decision } : {}),
        });
        if (outcome !== 'ok') span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
        return result;
      } finally {
        span.end();
      }
    });
  }

  private async execute(
    caller: Caller,
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    corr: Correlation,
  ): Promise<{ result: CallToolResult; outcome: Outcome; decision?: PolicyDecision }> {
    const refuse = (envelope: ToolEnvelope, outcome: Outcome) => ({
      result: toCallToolResult(envelope) as CallToolResult,
      outcome,
    });

    // (1) kill switch — refused before anything else runs or is recorded.
    const halt = this.deps.killSwitch?.fleetHalt();
    if (halt !== undefined) {
      return refuse(
        fail('upstream_auth', 'platform fleet halt is active — tool calls are refused'),
        'error:upstream_auth',
      );
    }
    if (caller.agentId !== undefined) {
      const suspension = this.deps.killSwitch?.agentSuspension(caller.agentId);
      if (suspension !== undefined) {
        return refuse(
          fail('upstream_auth', `agent ${caller.agentId} is suspended (kill switch)`),
          'error:upstream_auth',
        );
      }
    }
    // Principal-denylist backstop (0c QA MEDIUM). 0c revoked denylisted
    // principals only at broker time, so an outstanding ≤15min acp:tools token
    // for a denylisted principal kept opening tools until it expired — and a
    // denylisted user/service was never revoked at the gateway at all. Check
    // BOTH the acting principal (act.sub — the agent) and the original subject
    // (sub — the user/service the chain started from) against the raw-string
    // denylist; the watcher applies the KV key encoding symmetrically. Like
    // the sibling kill-switch refusals, this precedes the Cedar decision and
    // carries no policy reference; auditing all kill-switch refusals uniformly
    // is item 5's retrofit (SPRINT routed-to-item-5, from 0a QA #1).
    for (const sub of new Set([caller.principal, caller.sub])) {
      if (this.deps.killSwitch?.principalDenied(sub) !== undefined) {
        return refuse(
          fail('upstream_auth', `principal ${sub} is denylisted (kill switch)`),
          'error:upstream_auth',
        );
      }
    }

    // (2) governed lookup — the config allowlist IS the tool surface.
    const entry = this.deps.config.servers.get(serverId);
    const spec = entry?.tools[tool];
    if (entry === undefined || spec === undefined) {
      return refuse(
        fail(
          'not_found',
          `tool ${tool} is not governed on server ${serverId} — see deploy/dev/tool-servers.json`,
        ),
        'error:not_found',
      );
    }

    // Approval grounds derived from the VERIFIED token claims only — never
    // request-supplied. Trustworthy (bound) iff the token carries an approval
    // claim AND the brokered task binding matches THIS call's correlation AND
    // the approval's step matches THIS step. Absent correlation reads as "no
    // approval": an agent can neither forge nor replay a gate. Item 3 lights
    // up an R2 tool pair-policy that permits only when context.approval.granted.
    const approval = deriveApproval(caller.claims, corr);

    // Capability + compensation context, both from VERIFIED claims. Capability
    // is ALWAYS present (defaulting to R0) so an R2 tool pair-policy can bind
    // on it. Compensation is `active` only when a compensation claim rides a
    // token whose brokered task matches THIS correlation — so an unwind's tool
    // call is permitted (and not re-gated) exactly when it is a real unwind.
    const capabilityContext = deriveCapability(caller.claims);
    const compensationContext = deriveCompensation(caller.claims, corr);

    // (3) Cedar. Deny means NO upstream contact of any kind.
    const decision = await this.deps.policy.authorize({
      principal: {
        type: caller.entityType,
        id: caller.principal,
        attrs: { tenant: caller.tenant },
      },
      action: `tool:${serverId}:${tool}`,
      resource: { type: 'Service', id: `svc:${serverId}`, attrs: {} },
      context: {
        scopes: caller.scopes,
        tenant: caller.tenant,
        approval,
        capability: capabilityContext,
        compensation: compensationContext,
      },
      reason: {
        ...(corr.taskId !== undefined ? { task_id: corr.taskId } : {}),
        ...(corr.stepId !== undefined ? { step_id: corr.stepId } : {}),
        tenant: caller.tenant,
      },
    });
    const audit = (outcome: Outcome, extras: AuditExtras = {}) =>
      this.emitAudit(caller, serverId, tool, args, corr, decision, outcome, extras);

    if (decision.decision === 'deny') {
      await audit('denied');
      return {
        ...refuse(
          fail(
            'upstream_auth',
            `Cedar decision: deny for tool:${serverId}:${tool} by ${caller.principal} ` +
              `(bundle ${decision.bundle_version}); the delegated token lacks a scope any ` +
              'permit accepts',
          ),
          'denied',
        ),
        decision,
      };
    }
    // require-approval → REFUSE (the tool gateway is a verify-only PEP; it
    // never suspends). A three-way lift reaching here means the token carries
    // no approval grounds bound to this step — an approved call would have
    // presented the claim and Cedar would have permitted it via the pair
    // policy. Fail closed: an R2 write cannot execute on an R2-scoped token
    // alone.
    if (decision.decision === 'require-approval') {
      await audit('denied', {
        ...(!approval.granted && approval.approval_id !== undefined
          ? { approvalId: approval.approval_id }
          : {}),
      });
      return {
        ...refuse(
          fail(
            'upstream_auth',
            `Cedar decision: require-approval for tool:${serverId}:${tool} by ${caller.principal} ` +
              `(bundle ${decision.bundle_version}); the token carries no approval grounds bound to ` +
              'this step — an R2 write requires a human-approved, step-bound token',
          ),
          'denied',
        ),
        decision,
      };
    }

    // (3.5) STRUCTURAL risk-class enforcement — after Cedar (so the audit
    // carries a real policy block if there was one) and before the limiter (so
    // laundering probes do not consume quota). This is defense-in-depth: the
    // Cedar pair-policy AND this check must both pass for an R2 tool. The
    // check reads the executing risk from the VERIFIED `capability` claim, so
    // it cannot be laundered by a header or by self-declaration.
    //   - an R3 tool is refused unconditionally (platform-wide disabled);
    //   - with a capability context, a tool whose risk EXCEEDS the capability's
    //     risk is refused (an R0/R1 step cannot call an R2 tool; a compensator
    //     carries R2 and passes);
    //   - with NO capability context (a direct user/service caller, or a token
    //     that lost the claim across an actor change), every R2+ tool is
    //     refused — mutations flow only through the governed task path.
    const risk = enforceRiskClass(spec.risk, caller.claims.capability);
    if (risk !== undefined) {
      await audit('denied', { riskRefusal: risk });
      return {
        ...refuse(
          fail(
            'upstream_auth',
            `tool ${serverId}/${tool} (risk ${spec.risk}) refused: ${risk.reason} — ` +
              `executing capability context ${risk.capabilityDescription}. An R2 write executes ` +
              'only on a token whose signed capability claim declares risk >= the tool risk.',
          ),
          'denied',
        ),
        decision,
      };
    }

    // (4) rate limit — after Cedar so denials never consume quota.
    const taken = this.deps.limiter.take(serverId, tool, caller.tenant);
    if (!taken.allowed) {
      await audit('rate_limited', { retryAfterS: taken.retryAfterS });
      return {
        ...refuse(
          fail(
            'rate_limited',
            `tool ${serverId}/${tool} rate limited for tenant ${caller.tenant} — ` +
              `retry after ${taken.retryAfterS}s`,
            taken.retryAfterS,
          ),
          'rate_limited',
        ),
        decision,
      };
    }

    // (5) input validation against the upstream's advertised schema.
    const toolInfo = await this.deps.upstreams.toolInfo(serverId, tool).catch(() => undefined);
    if (toolInfo !== undefined) {
      const validated = this.validators.validate(toolInfo.inputSchema, args);
      if (!validated.ok) {
        await audit('error:invalid_input');
        return {
          ...refuse(
            fail(
              'invalid_input',
              `invalid arguments for ${serverId}/${tool}: ${validated.violations.join('; ')}`,
            ),
            'error:invalid_input',
          ),
          decision,
        };
      }
    }

    // (6) credential brokering — failures are upstream_auth, passthrough.
    let headers: Record<string, string>;
    try {
      headers = await this.deps.broker.headersFor(entry, caller, corr);
    } catch (err) {
      await audit('error:upstream_auth');
      return {
        ...refuse(
          fail('upstream_auth', err instanceof Error ? err.message : String(err)),
          'error:upstream_auth',
        ),
        decision,
      };
    }

    // (7) forward. The caller's Authorization is structurally absent here:
    // `headers` came from the broker alone.
    let result: CallToolResult;
    try {
      result = await this.deps.upstreams.callTool(serverId, tool, args, headers, entry.timeout_ms);
    } catch (err) {
      await audit('error:unavailable');
      return {
        ...refuse(
          fail(
            'unavailable',
            `tool server ${serverId} did not answer: ` +
              (err instanceof Error ? err.message : String(err)),
          ),
          'error:unavailable',
        ),
        decision,
      };
    }

    // (8) response validation: the result must be a ToolEnvelope (and pass
    // the tool's outputSchema when it declares one). A malformed upstream
    // result is substituted with a deliberately envelope-less isError text
    // so the client maps it permanent — never forwarded as if trustworthy.
    const envelope = parseToolEnvelope(result);
    const outputOk =
      envelope !== undefined &&
      (toolInfo?.outputSchema === undefined ||
        this.validators.validate(toolInfo.outputSchema, envelope).ok);
    if (envelope === undefined || !outputOk) {
      await audit('error:malformed');
      return {
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: `upstream tool ${serverId}/${tool} returned a result that failed schema validation`,
            },
          ],
        },
        outcome: 'error:malformed',
        decision,
      };
    }

    // (9) audit + (10) verbatim return. Upstream envelope errors pass
    // through untouched and are audited as error:{code}.
    if (envelope.ok) {
      const lineageIds = [...new Set(envelope.provenance.map((p) => p.lineage_id))];
      await audit('ok', { lineageIds });
      return { result, outcome: 'ok', decision };
    }
    const errorOutcome: Outcome = `error:${envelope.error.code}`;
    await audit(errorOutcome, {
      ...(envelope.error.retry_after_s !== undefined
        ? { retryAfterS: envelope.error.retry_after_s }
        : {}),
    });
    return { result, outcome: errorOutcome, decision };
  }

  private async emitAudit(
    caller: Caller,
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    corr: Correlation,
    decision: PolicyDecision,
    outcome: Outcome,
    extras: AuditExtras,
  ): Promise<void> {
    const event: AuditEvent = {
      event_id: randomUUID(),
      occurred_at: (this.deps.now?.() ?? new Date()).toISOString(),
      tenant: caller.tenant,
      event_type: 'tool.called',
      actor: { principal: caller.principal, delegation_chain: delegationChain(caller.claims) },
      action: {
        name: `tool:${serverId}:${tool}`,
        inputs_digest: sha256Digest(JSON.stringify(args)),
      },
      reason: {
        ...(corr.taskId !== undefined ? { task_id: corr.taskId } : {}),
        ...(corr.stepId !== undefined ? { step_id: corr.stepId } : {}),
        policy: {
          decision: decision.decision,
          bundle_version: decision.bundle_version,
          determining_policies: decision.determining_policies,
        },
      },
      ...(extras.lineageIds !== undefined && extras.lineageIds.length > 0
        ? { artifacts: { lineage_ids: extras.lineageIds } }
        : {}),
      details: {
        server: serverId,
        tool,
        outcome,
        ...(extras.retryAfterS !== undefined ? { retry_after_s: extras.retryAfterS } : {}),
        ...(extras.approvalId !== undefined ? { approval_id: extras.approvalId } : {}),
        ...(extras.riskRefusal !== undefined
          ? {
              refusal: 'risk_class',
              tool_risk: extras.riskRefusal.toolRisk,
              capability: extras.riskRefusal.capability,
              capability_risk: extras.riskRefusal.capabilityRisk,
            }
          : {}),
      },
    };
    try {
      await this.deps.audit.publish(event);
    } catch (err) {
      // R0 alarm-and-continue; R1+ tool calls fail closed here in Phase 3.
      this.deps.logger.error({ err }, 'tool.called audit failed (alarm-and-continue, R0)');
    }
  }
}

interface AuditExtras {
  lineageIds?: string[];
  retryAfterS?: number;
  /** Present when a require-approval refusal saw an approval claim that did not bind to this step. */
  approvalId?: string;
  /** Present when a structural risk-class refusal fired (step 3.5). */
  riskRefusal?: RiskRefusal;
}

/** The approval context handed to Cedar: granted only when a claim binds to THIS step. */
type ApprovalContext =
  | { granted: true; capability: string; approval_id: string; step_id: string }
  | { granted: false; approval_id?: string };

/**
 * Derives approval grounds from VERIFIED claims. Bound (granted) only when the
 * token's approval claim is tied to THIS exact call: the brokered task binding
 * matches the correlation's task, and the approval's step matches the
 * correlation's step. Any gap — no claim, no correlation, task/step mismatch —
 * is {granted:false}, so an agent cannot forge a gate or replay an approval
 * onto a different step. When a claim is present but unbound, its id rides the
 * refusal audit for investigation.
 */
/** Cedar context for the executing capability — always present (R0 default). */
interface CapabilityContext {
  name: string;
  risk: string;
}

/** Cedar context for a compensation unwind, active only when bound to this task. */
type CompensationContext =
  | { active: true; original_capability: string; original_step_id: string }
  | { active: false };

/** A structural risk-class refusal (step 3.5) and its audit fields. */
interface RiskRefusal {
  reason: string;
  capabilityDescription: string;
  toolRisk: string;
  capability: string;
  capabilityRisk: string;
}

function rankOf(risk: string): number {
  // An unknown risk ranks as the most restrictive (R3) — fail-safe.
  switch (risk) {
    case 'R0':
      return 0;
    case 'R1':
      return 1;
    case 'R2':
      return 2;
    default:
      return 3;
  }
}

/**
 * The structural risk-class check. Returns a RiskRefusal to block, or
 * undefined to allow. Reads the executing risk from the VERIFIED capability
 * claim only. R3 is refused unconditionally; with a capability context a tool
 * exceeding its risk is refused; with NO capability context every R2+ tool is
 * refused (mutations flow only through the governed task path).
 */
function enforceRiskClass(
  toolRisk: string,
  capability: Caller['claims']['capability'],
): RiskRefusal | undefined {
  if (rankOf(toolRisk) >= rankOf('R3')) {
    return {
      reason: 'R3 tools are disabled platform-wide',
      capabilityDescription: capability === undefined ? 'none' : `${capability.name} (${capability.risk})`,
      toolRisk,
      capability: capability?.name ?? '',
      capabilityRisk: capability?.risk ?? '',
    };
  }
  if (capability === undefined) {
    if (rankOf(toolRisk) >= rankOf('R2')) {
      return {
        reason: 'no capability context — an R2+ tool call outside the governed task path is refused',
        capabilityDescription: 'none',
        toolRisk,
        capability: '',
        capabilityRisk: '',
      };
    }
    return undefined;
  }
  if (rankOf(toolRisk) > rankOf(capability.risk)) {
    return {
      reason: `tool risk exceeds capability risk (risk-class laundering)`,
      capabilityDescription: `${capability.name} (${capability.risk})`,
      toolRisk,
      capability: capability.name,
      capabilityRisk: capability.risk,
    };
  }
  return undefined;
}

/** Cedar capability context from the verified claim — defaults to R0 when absent. */
function deriveCapability(claims: Caller['claims']): CapabilityContext {
  return claims.capability ?? { name: '', risk: 'R0' };
}

/**
 * Cedar compensation context from the verified claim. Active only when the
 * token carries a compensation claim AND its brokered task binding matches
 * THIS correlation — so a compensator's tool call is permitted (not re-gated)
 * exactly when it is a real unwind of this task, never replayed elsewhere.
 */
function deriveCompensation(claims: Caller['claims'], corr: Correlation): CompensationContext {
  const claim = claims.compensation;
  if (
    claim === undefined ||
    claims.brokered?.task_id === undefined ||
    corr.taskId === undefined ||
    claims.brokered.task_id !== corr.taskId
  ) {
    return { active: false };
  }
  return {
    active: true,
    original_capability: claim.original_capability,
    original_step_id: claim.original_step_id,
  };
}

function deriveApproval(claims: Caller['claims'], corr: Correlation): ApprovalContext {
  const claim = claims.approval;
  if (claim === undefined) return { granted: false };
  const bound =
    claims.brokered?.task_id !== undefined &&
    corr.taskId !== undefined &&
    claims.brokered.task_id === corr.taskId &&
    corr.stepId !== undefined &&
    corr.stepId === claim.step_id;
  if (!bound) return { granted: false, approval_id: claim.id };
  return {
    granted: true,
    capability: claim.capability,
    approval_id: claim.id,
    step_id: claim.step_id,
  };
}
