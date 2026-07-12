/**
 * The enforcement pipeline — every completion passes, in order:
 *
 *   (1) kill switch (fleet halt, agent suspension)
 *   (2) model-class lookup (the config registry IS the class surface)
 *   (3) model allowlist for agent callers (registry card, fail closed)
 *   (4) prompt validation + stable-prefix assembly (static ++ variable)
 *   (5) the failover loop: ordered bindings, ≤ max_attempts each,
 *       full-jitter backoff, per-attempt timeout, 60s overall deadline
 *   (6) model.invoked audit + OTel llm.complete span (the Cost Meter's
 *       pricing record) + typed response
 *
 * Intra-call failover lives HERE; Temporal retries the whole activity if
 * the gateway gives up (orchestration.md's two-layer retry story). Audit
 * is R0 alarm-and-continue. Kill-switch and unknown-class refusals
 * precede the enforcement decision and carry nothing to record — the
 * same line the tool gateway draws.
 */

import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { AuditEvent } from '@acp/protocol';
import { delegationChain, sha256Digest, type Logger } from '@acp/service-kit';
import type {
  CompletionAttempt,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  LlmErrorBody,
  LlmErrorClass,
  ModelClassesResponse,
} from '@acp/llm-client';
import { RegistryUnavailableError, type AllowlistCheck } from './allowlist.js';
import type { ModelBinding, ModelClassConfig } from './classes.js';
import type { Caller } from './caller.js';
import { stableStringify, validatePrompt, type ValidatedPrompt } from './prompt.js';
import { ProviderFault, type ProviderAdapter, type ProviderCompletion } from './providers/index.js';

/** Structural slice of service-kit's KillSwitchWatcher — tests stub it. */
export interface KillSwitch {
  fleetHalt(): { active: boolean; reason?: string } | undefined;
  agentSuspension(agentId: string): { active: boolean; reason?: string } | undefined;
}

/** Structural slice of RegistryAllowlist — tests stub it. */
export interface Allowlist {
  check(agentId: string, modelClass: string): Promise<AllowlistCheck>;
}

export interface AuditSink {
  publish(event: AuditEvent): Promise<void>;
}

export interface CoreDeps {
  config: ModelClassConfig;
  providers: Map<string, ProviderAdapter>;
  allowlist: Allowlist;
  audit: AuditSink;
  killSwitch?: KillSwitch | undefined;
  logger: Logger;
  now?: (() => Date) | undefined;
  /** Injectable backoff sleep — the failover tests pin delays without waiting. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injectable jitter source in [0, 1). */
  random?: (() => number) | undefined;
  /** Overall per-request deadline. Default 60s. */
  deadlineMs?: number | undefined;
}

export interface Correlation {
  taskId?: string | undefined;
  stepId?: string | undefined;
}

export type CompleteResult =
  { status: 200; body: CompletionResponse } | { status: 400 | 403 | 429 | 503; body: LlmErrorBody };

type Outcome = 'ok' | 'model_not_allowed' | 'invalid_input' | 'rate_limited' | 'unavailable';

const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 2_000;
const DEFAULT_DEADLINE_MS = 60_000;
const MAX_TRACKED_PREFIX_KEYS = 1024;

const tracer = trace.getTracer('llm-gateway');

function errorBody(
  cls: LlmErrorClass,
  message: string,
  status: 400 | 403 | 429 | 503,
  retryAfterS?: number,
) {
  return {
    status,
    body: {
      error: {
        class: cls,
        message,
        status,
        ...(retryAfterS !== undefined ? { retry_after_s: retryAfterS } : {}),
      },
    } satisfies LlmErrorBody,
  };
}

export class LlmGatewayCore {
  /** Last prefix digest per (caller principal, class) — the stability signal. */
  private readonly lastPrefix = new Map<string, string>();

  constructor(private readonly deps: CoreDeps) {}

  modelClasses(): ModelClassesResponse {
    const classes: Record<string, { models: string[] }> = {};
    for (const [name, entry] of this.deps.config.classes) {
      classes[name] = { models: entry.bindings.map((b) => `${b.provider}/${b.model}`) };
    }
    return { version: this.deps.config.version, classes };
  }

  async complete(
    caller: Caller,
    request: CompletionRequest,
    corr: Correlation,
  ): Promise<CompleteResult> {
    // Body metadata wins over correlation headers.
    const taskId = request.metadata?.task_id ?? corr.taskId;
    const stepId = request.metadata?.step_id ?? corr.stepId;

    return tracer.startActiveSpan(`llm.complete ${request.model_class}`, async (span) => {
      span.setAttributes({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': request.model_class,
        'acp.tenant': caller.tenant,
        'acp.principal': caller.principal,
        'acp.llm.model_class': request.model_class,
        'acp.llm.model_classes_version': this.deps.config.version,
        ...(taskId !== undefined ? { 'acp.task_id': taskId } : {}),
        ...(stepId !== undefined ? { 'acp.step_id': stepId } : {}),
        ...(request.metadata?.capability !== undefined
          ? { 'acp.capability': request.metadata.capability }
          : {}),
      });
      try {
        const result = await this.execute(caller, request, { taskId, stepId }, span);
        if (result.status !== 200) {
          span.setAttribute('acp.outcome', result.body.error.class);
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.body.error.class });
        } else {
          span.setAttribute('acp.outcome', 'ok');
        }
        return result;
      } finally {
        span.end();
      }
    });
  }

  private async execute(
    caller: Caller,
    request: CompletionRequest,
    corr: Correlation,
    span: ReturnType<typeof tracer.startSpan>,
  ): Promise<CompleteResult> {
    // (1) kill switch — refused before anything else runs or is recorded.
    const halt = this.deps.killSwitch?.fleetHalt();
    if (halt !== undefined) {
      return errorBody(
        'killswitch',
        'platform fleet halt is active — completions are refused',
        503,
      );
    }
    if (caller.agentId !== undefined) {
      const suspension = this.deps.killSwitch?.agentSuspension(caller.agentId);
      if (suspension !== undefined) {
        return errorBody('killswitch', `agent ${caller.agentId} is suspended (kill switch)`, 503);
      }
    }

    // (2) model-class lookup — the config registry IS the class surface.
    const entry = this.deps.config.classes.get(request.model_class);
    if (entry === undefined) {
      return errorBody(
        'model_class_unknown',
        `unknown model class ${request.model_class} — registry version ` +
          `${this.deps.config.version} defines: ${[...this.deps.config.classes.keys()].sort().join(', ')}`,
        400,
      );
    }

    // (4, before 3 for digests) prompt validation + assembly. Refusing a
    // malformed prompt needs no registry round-trip.
    const validated = validatePrompt(request.prompt);
    if (!validated.ok) {
      const result = errorBody(
        'invalid_input',
        `invalid prompt: ${validated.violations.join('; ')}`,
        400,
      );
      await this.emitAudit(caller, request, corr, 'invalid_input', {
        inputsDigest: sha256Digest(stableStringify(request.prompt)),
        attempts: [],
      });
      return result;
    }
    const prompt = validated.prompt;
    const inputsDigest = sha256Digest(stableStringify(prompt.blocks));
    span.setAttribute('acp.llm.prefix_digest', prompt.prefixDigest);

    // (3) model allowlist for agent callers — registry card, fail closed.
    if (caller.agentId !== undefined) {
      let check: AllowlistCheck;
      try {
        check = await this.deps.allowlist.check(caller.agentId, request.model_class);
      } catch (err) {
        const message =
          err instanceof RegistryUnavailableError
            ? `model allowlist unavailable: ${err.message}`
            : `model allowlist unavailable: ${err instanceof Error ? err.message : String(err)}`;
        const result = errorBody('unavailable', message, 503);
        await this.emitAudit(caller, request, corr, 'unavailable', {
          inputsDigest,
          prefixDigest: prompt.prefixDigest,
          attempts: [],
        });
        return result;
      }
      if (!check.allowed) {
        const result = errorBody(
          'model_not_allowed',
          `agent ${caller.agentId} may not use model class ${request.model_class} — ` +
            `manifest models.allowed: [${check.allowedClasses.join(', ')}]`,
          403,
        );
        await this.emitAudit(caller, request, corr, 'model_not_allowed', {
          inputsDigest,
          prefixDigest: prompt.prefixDigest,
          attempts: [],
        });
        return result;
      }
    }

    // (5) the failover loop.
    const outcome = await this.failover(entry.bindings, prompt, request);

    // Prefix stability: same digest as this caller's previous call on this
    // class? The dashboardable cache-hit-rate signal (cost-management.md).
    const prefixKey = `${caller.principal} ${request.model_class}`;
    const prefixStable = this.lastPrefix.get(prefixKey) === prompt.prefixDigest;
    this.lastPrefix.delete(prefixKey);
    this.lastPrefix.set(prefixKey, prompt.prefixDigest);
    if (this.lastPrefix.size > MAX_TRACKED_PREFIX_KEYS) {
      const oldest = this.lastPrefix.keys().next().value;
      if (oldest !== undefined) this.lastPrefix.delete(oldest);
    }
    span.setAttributes({
      'acp.llm.prefix_stable': prefixStable,
      'acp.llm.attempts': outcome.attempts.length,
    });

    if (outcome.kind === 'ok') {
      const { binding, completion } = outcome;
      span.setAttributes({
        'gen_ai.response.model': binding.model,
        'gen_ai.provider.name': binding.provider,
        'gen_ai.usage.input_tokens': completion.usage.input_tokens,
        'gen_ai.usage.output_tokens': completion.usage.output_tokens,
        'gen_ai.usage.cache_read_input_tokens': completion.usage.cache_read_input_tokens,
        'gen_ai.usage.cache_creation_input_tokens': completion.usage.cache_creation_input_tokens,
      });
      const body: CompletionResponse = {
        text: completion.text,
        model_class: request.model_class,
        model: binding.model,
        provider: binding.provider,
        model_classes_version: this.deps.config.version,
        usage: completion.usage,
        attempts: outcome.attempts,
      };
      await this.emitAudit(caller, request, corr, 'ok', {
        inputsDigest,
        outputsDigest: sha256Digest(completion.text),
        prefixDigest: prompt.prefixDigest,
        attempts: outcome.attempts,
        model: `${binding.provider}/${binding.model}`,
        provider: binding.provider,
        usage: completion.usage,
      });
      return { status: 200, body };
    }

    if (outcome.kind === 'invalid_input') {
      const result = errorBody(
        'invalid_input',
        `provider refused the request: ${outcome.fault.message}`,
        400,
      );
      await this.emitAudit(caller, request, corr, 'invalid_input', {
        inputsDigest,
        prefixDigest: prompt.prefixDigest,
        attempts: outcome.attempts,
      });
      return result;
    }

    // Exhausted: 429 iff EVERY binding ended terminally rate-limited —
    // then the caller should genuinely back off; anything mixed is a 503
    // the orchestration layer may retry on its own schedule.
    const allRateLimited =
      outcome.terminalFaults.length > 0 &&
      outcome.terminalFaults.every((fault) => fault.kind === 'rate_limited');
    const result = allRateLimited
      ? errorBody(
          'rate_limited',
          `model class ${request.model_class}: every provider binding is rate limited`,
          429,
          Math.max(...outcome.terminalFaults.map((fault) => fault.retryAfterS ?? 1)),
        )
      : errorBody(
          'unavailable',
          `model class ${request.model_class}: all provider bindings failed after ` +
            `${outcome.attempts.length} attempt(s)` +
            (outcome.deadlineExceeded ? ' (overall deadline exceeded)' : ''),
          503,
        );
    await this.emitAudit(caller, request, corr, allRateLimited ? 'rate_limited' : 'unavailable', {
      inputsDigest,
      prefixDigest: prompt.prefixDigest,
      attempts: outcome.attempts,
    });
    return result;
  }

  private async failover(
    bindings: ModelBinding[],
    prompt: ValidatedPrompt,
    request: CompletionRequest,
  ): Promise<FailoverOutcome> {
    const now = this.deps.now ?? (() => new Date());
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = this.deps.random ?? Math.random;
    const deadline = now().getTime() + (this.deps.deadlineMs ?? DEFAULT_DEADLINE_MS);

    const attempts: CompletionAttempt[] = [];
    const terminalFaults: ProviderFault[] = [];
    let deadlineExceeded = false;

    for (const binding of bindings) {
      // The loader guarantees every binding names a configured provider.
      const adapter = this.deps.providers.get(binding.provider);
      if (adapter === undefined) {
        terminalFaults.push(
          new ProviderFault('server', `provider ${binding.provider} is not configured`),
        );
        continue;
      }
      let bindingFault: ProviderFault | undefined;
      for (let attempt = 0; attempt < binding.max_attempts; attempt++) {
        const remaining = deadline - now().getTime();
        if (remaining <= 0) {
          deadlineExceeded = true;
          break;
        }
        const started = now().getTime();
        try {
          const completion = await this.attemptOnce(
            adapter,
            binding,
            prompt,
            request,
            Math.min(binding.timeout_ms, remaining),
          );
          attempts.push({
            provider: binding.provider,
            model: binding.model,
            outcome: 'ok',
            duration_ms: Math.max(0, now().getTime() - started),
          });
          return { kind: 'ok', binding, completion, attempts };
        } catch (err) {
          const fault =
            err instanceof ProviderFault
              ? err
              : new ProviderFault('server', err instanceof Error ? err.message : String(err));
          attempts.push({
            provider: binding.provider,
            model: binding.model,
            outcome: fault.kind,
            duration_ms: Math.max(0, now().getTime() - started),
          });
          if (fault.kind === 'invalid_input') {
            // The request itself is wrong; no other binding will disagree.
            return { kind: 'invalid_input', fault, attempts };
          }
          bindingFault = fault;
          if (fault.kind === 'upstream_auth') {
            // Retrying a bad credential is noise — fail over immediately.
            break;
          }
          if (attempt < binding.max_attempts - 1) {
            // Full-jitter exponential backoff: U(0, min(cap, base·2^n)).
            await sleep(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
          }
        }
      }
      if (bindingFault !== undefined) terminalFaults.push(bindingFault);
      if (deadlineExceeded) break;
    }
    return { kind: 'exhausted', attempts, terminalFaults, deadlineExceeded };
  }

  private attemptOnce(
    adapter: ProviderAdapter,
    binding: ModelBinding,
    prompt: ValidatedPrompt,
    request: CompletionRequest,
    timeoutMs: number,
  ): Promise<ProviderCompletion> {
    return tracer.startActiveSpan(
      `llm.attempt ${binding.provider}/${binding.model}`,
      async (span) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        try {
          // The race backstops adapters that ignore the signal: the attempt
          // deadline holds even if the upstream never answers.
          const completion = await Promise.race([
            adapter.complete(binding.model, {
              prompt,
              maxTokens: request.max_tokens ?? 1024,
              temperature: request.temperature ?? 0,
              signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(
                  new ProviderFault(
                    'timeout',
                    `${binding.provider}/${binding.model} did not answer within ${timeoutMs}ms`,
                  ),
                );
              });
            }),
          ]);
          span.setAttribute('acp.outcome', 'ok');
          return completion;
        } catch (err) {
          const kind = err instanceof ProviderFault ? err.kind : 'server';
          span.setAttribute('acp.outcome', kind);
          span.setStatus({ code: SpanStatusCode.ERROR, message: kind });
          throw err;
        } finally {
          clearTimeout(timer);
          span.end();
        }
      },
    );
  }

  private async emitAudit(
    caller: Caller,
    request: CompletionRequest,
    corr: Correlation,
    outcome: Outcome,
    extras: {
      inputsDigest: string;
      outputsDigest?: string;
      prefixDigest?: string;
      attempts: CompletionAttempt[];
      model?: string;
      provider?: string;
      usage?: CompletionUsage;
    },
  ): Promise<void> {
    const event: AuditEvent = {
      event_id: randomUUID(),
      occurred_at: (this.deps.now?.() ?? new Date()).toISOString(),
      tenant: caller.tenant,
      event_type: 'model.invoked',
      actor: { principal: caller.principal, delegation_chain: delegationChain(caller.claims) },
      action: {
        name: `llm:${request.model_class}`,
        inputs_digest: extras.inputsDigest,
        ...(extras.outputsDigest !== undefined ? { outputs_digest: extras.outputsDigest } : {}),
      },
      reason: {
        ...(corr.taskId !== undefined ? { task_id: corr.taskId } : {}),
        ...(corr.stepId !== undefined ? { step_id: corr.stepId } : {}),
      },
      ...(extras.model !== undefined || caller.agentId !== undefined
        ? {
            artifacts: {
              ...(extras.model !== undefined ? { model: extras.model } : {}),
              ...(caller.agentId !== undefined ? { agent_id: caller.agentId } : {}),
            },
          }
        : {}),
      details: {
        model_class: request.model_class,
        outcome,
        attempts: extras.attempts,
        model_classes_version: this.deps.config.version,
        ...(extras.provider !== undefined ? { provider: extras.provider } : {}),
        ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
        ...(extras.prefixDigest !== undefined ? { prefix_digest: extras.prefixDigest } : {}),
        ...(request.metadata?.purpose !== undefined ? { purpose: request.metadata.purpose } : {}),
      },
    };
    try {
      await this.deps.audit.publish(event);
    } catch (err) {
      // R0 alarm-and-continue; completions are reads of a model, not writes.
      this.deps.logger.error({ err }, 'model.invoked audit failed (alarm-and-continue, R0)');
    }
  }
}

type FailoverOutcome =
  | {
      kind: 'ok';
      binding: ModelBinding;
      completion: ProviderCompletion;
      attempts: CompletionAttempt[];
    }
  | { kind: 'invalid_input'; fault: ProviderFault; attempts: CompletionAttempt[] }
  | {
      kind: 'exhausted';
      attempts: CompletionAttempt[];
      terminalFaults: ProviderFault[];
      deadlineExceeded: boolean;
    };
