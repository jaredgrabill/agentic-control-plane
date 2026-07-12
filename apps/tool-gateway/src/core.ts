/**
 * The enforcement pipeline — every tools/call passes, in order:
 *
 *   (1) kill switch (fleet halt, agent suspension)
 *   (2) governed-tool lookup (config allowlist)
 *   (3) Cedar decision (deny → refused BEFORE any upstream contact)
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

    // (3) Cedar. Deny means NO upstream contact of any kind.
    const decision = await this.deps.policy.authorize({
      principal: {
        type: caller.entityType,
        id: caller.principal,
        attrs: { tenant: caller.tenant },
      },
      action: `tool:${serverId}:${tool}`,
      resource: { type: 'Service', id: `svc:${serverId}`, attrs: {} },
      context: { scopes: caller.scopes, tenant: caller.tenant },
      reason: {
        ...(corr.taskId !== undefined ? { task_id: corr.taskId } : {}),
        ...(corr.stepId !== undefined ? { step_id: corr.stepId } : {}),
        tenant: caller.tenant,
      },
    });
    const audit = (outcome: Outcome, extras: AuditExtras = {}) =>
      this.emitAudit(caller, serverId, tool, args, corr, decision, outcome, extras);

    if (decision.decision !== 'allow') {
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
}
