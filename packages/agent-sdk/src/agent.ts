/**
 * Agent: manifest binding + capability handlers + runtime. You never touch
 * transport (paved-road.md) — work arrives as Temporal activities on this
 * agent's task queue, and the SDK owns the polyglot contract with the
 * orchestrator.
 */

import { readFileSync } from 'node:fs';
import { trace } from '@opentelemetry/api';
import { ApplicationFailure } from '@temporalio/common';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { Logger } from 'pino';
import YAML from 'yaml';
import { agentManifest, stepRequest, type AgentManifest, type StepRequest } from '@acp/protocol';
import type { StepResult, Usage } from '@acp/protocol';
import { AnswerBuilder } from './answer.js';
import { CapabilityContext } from './context.js';
import { CapabilityError, ErrorClass } from './errors.js';
import { FakeModel, isContextualModel, type ModelClient, type ModelResponse } from './model.js';
import type { Retriever } from './retriever.js';
import { createAgentLogger } from './telemetry.js';

/** A capability handler: context + validated input → output conforming to the declared schema. */
export type Handler = (
  ctx: CapabilityContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface AgentOptions {
  manifest: AgentManifest;
  model?: ModelClient;
  retriever?: Retriever;
}

/** Generated `{}`-typed fields carry objects on the wire; narrow them once, here. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Wraps the configured model so usage lands in the StepResult. */
class CountingModel implements ModelClient {
  llmCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  /** Last non-undefined resolved model id seen across completions (v0 last-write-wins). */
  model: string | undefined;

  constructor(private readonly inner: ModelClient) {}

  async complete(prompt: string, options?: { maxTokens?: number }): Promise<ModelResponse> {
    this.llmCalls += 1;
    const response = await this.inner.complete(prompt, options);
    this.inputTokens += response.inputTokens ?? 0;
    this.outputTokens += response.outputTokens ?? 0;
    this.cacheReadTokens += response.cacheReadTokens ?? 0;
    this.cacheWriteTokens += response.cacheWriteTokens ?? 0;
    if (response.model !== undefined) this.model = response.model;
    return response;
  }
}

/** One agent = manifest + handlers + tool bindings + eval suite. */
export class Agent {
  readonly manifest: AgentManifest;
  /** Mutable: `serveAgent()` installs a GatewayModel when none was configured. */
  model: ModelClient | undefined;
  /** Mutable: `run()` installs a NatsRetriever when none was configured. */
  retriever: Retriever | undefined;
  /** Lazy unit-test fallback: an unconfigured, unserved agent still fakes. */
  private fallbackFake: FakeModel | undefined;
  readonly handlers = new Map<string, Handler>();
  readonly log: Logger;
  // The SDK's own lenient instance for capability output_schemas — authored
  // by agent teams, not protocol schemas — so their idioms don't trip Ajv
  // strict mode. Protocol documents keep using @acp/protocol's strict one.
  //
  // validateFormats: false for 1:1 parity with the Python SDK, whose
  // Draft202012Validator carries no FormatChecker — there `format:` is
  // annotation-only (jsonschema's spec-default), so it must never cause an
  // output validation failure here either. With formats off, Ajv also
  // compiles unknown format names without ajv-formats.
  private readonly ajv: Ajv2020;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(options: AgentOptions) {
    this.manifest = options.manifest;
    this.model = options.model;
    this.retriever = options.retriever;
    this.log = createAgentLogger(this.agentId);
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  }

  /** Loads + validates a manifest.yaml; throws ProtocolValidationError on drift. */
  static fromManifest(
    manifestPath: string,
    options: { model?: ModelClient; retriever?: Retriever } = {},
  ): Agent {
    const raw: unknown = YAML.parse(readFileSync(manifestPath, 'utf-8'));
    const manifest = agentManifest.parse(raw);
    const agentOptions: AgentOptions = { manifest };
    if (options.model !== undefined) agentOptions.model = options.model;
    if (options.retriever !== undefined) agentOptions.retriever = options.retriever;
    return new Agent(agentOptions);
  }

  get agentId(): string {
    return this.manifest.id;
  }

  /** Must equal the orchestrator's agentTaskQueue() — the dispatch contract. */
  get taskQueue(): string {
    return `agent-${this.agentId}`;
  }

  /** Registers the handler for a manifest-declared capability. */
  capability(name: string, handler: Handler): void {
    const declared = this.manifest.capabilities.map((c) => c.name);
    if (!declared.includes(name)) {
      throw new Error(
        `capability ${name} is not declared in the manifest for ${this.agentId} — ` +
          `declared: ${[...declared].sort().join(', ')}. Add it to manifest.yaml first; ` +
          'the manifest is the contract.',
      );
    }
    if (this.handlers.has(name)) {
      throw new Error(`capability ${name} already has a handler`);
    }
    this.handlers.set(name, handler);
  }

  /** Every declared capability must have a handler before serving. */
  assertComplete(): void {
    const missing = this.manifest.capabilities
      .map((c) => c.name)
      .filter((name) => !this.handlers.has(name));
    if (missing.length > 0) {
      throw new Error(`manifest declares capabilities with no handler: ${missing.join(', ')}`);
    }
  }

  answerBuilder(): AnswerBuilder {
    return new AnswerBuilder();
  }

  /**
   * The execute_capability activity body: StepRequest → StepResult.
   *
   * Output is validated against the capability's declared output_schema with
   * one structured-repair retry, then the step fails typed — never a
   * best-effort parse (orchestration.md).
   */
  async execute(request: unknown): Promise<StepResult> {
    const errors = stepRequest.errors(request);
    if (errors.length > 0) {
      throw ApplicationFailure.create({
        message: `malformed StepRequest: ${errors.join('; ')}`,
        type: 'Permanent',
        nonRetryable: true,
      });
    }
    const req = request as StepRequest;
    const handler = this.handlers.get(req.capability);
    if (handler === undefined) {
      return this.failed(
        req,
        new CapabilityError(
          ErrorClass.Permanent,
          `agent ${this.agentId} has no handler for ${req.capability}`,
        ),
      );
    }

    // A contextual model (the GatewayModel) is bound to THIS step's
    // delegated identity + correlation before it reaches the handler;
    // FakeModel is not contextual, so unit tests see zero change.
    const base = this.model ?? (this.fallbackFake ??= new FakeModel());
    const bound = isContextualModel(base)
      ? base.withCallContext({
          delegatedToken: req.delegated_token,
          taskId: req.task_id,
          stepId: req.step_id,
          tenant: req.tenant,
          capability: req.capability,
        })
      : base;
    const counting = new CountingModel(bound);
    const ctx = new CapabilityContext({
      tenant: req.tenant,
      taskId: req.task_id,
      stepId: req.step_id,
      capability: req.capability,
      delegatedToken: req.delegated_token,
      budget: req.budget,
      model: counting,
      retriever: this.retriever,
      log: this.log.child({ task_id: req.task_id, step_id: req.step_id }),
    });

    const tracer = trace.getTracer('acp-agent-sdk');
    return await tracer.startActiveSpan(`invoke_agent ${req.capability}`, async (span) => {
      span.setAttributes({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': this.agentId,
        'acp.tenant': req.tenant,
        'acp.task_id': req.task_id,
        'acp.capability': req.capability,
      });
      try {
        const output = await this.executeValidated(handler, ctx, req);
        span.setAttribute('acp.step_status', 'completed');
        return {
          kind: 'step_result',
          step_id: req.step_id,
          task_id: req.task_id,
          tenant: req.tenant,
          status: 'completed',
          output,
          usage: usageOf(counting),
        } satisfies StepResult;
      } catch (err) {
        if (err instanceof CapabilityError) {
          if (err.errorClass === ErrorClass.Retryable) {
            // Temporal owns retries; surface as a retryable failure.
            throw ApplicationFailure.create({
              message: err.message,
              type: 'Retryable',
              nonRetryable: false,
            });
          }
          span.setAttribute('acp.step_status', 'failed');
          return this.failed(req, err, counting);
        }
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Serves this agent's task queue until cancelled (live Temporal + NATS; E2E covers it). */
  async run(): Promise<void> {
    const { serveAgent } = await import('./worker.js');
    await serveAgent(this);
  }

  private validatorFor(capability: string): ValidateFunction {
    const cached = this.validators.get(capability);
    if (cached !== undefined) return cached;
    const declared = this.manifest.capabilities.find((c) => c.name === capability);
    if (declared === undefined) {
      // Unreachable through execute(): handlers only register declared names.
      throw new Error(`capability ${capability} is not declared in the manifest`);
    }
    const compiled = this.ajv.compile(asRecord(declared.output_schema));
    this.validators.set(capability, compiled);
    return compiled;
  }

  private async executeValidated(
    handler: Handler,
    ctx: CapabilityContext,
    req: StepRequest,
  ): Promise<Record<string, unknown>> {
    const validate = this.validatorFor(ctx.capability);
    const input = asRecord(req.input);
    let output = await handler(ctx, input);
    let violations = violationsOf(validate, output);
    if (violations.length === 0) return output;
    ctx.log.warn(
      { errors: violations },
      'output failed schema validation; structured-repair retry',
    );
    output = await handler(ctx, input);
    violations = violationsOf(validate, output);
    if (violations.length > 0) {
      throw new CapabilityError(
        ErrorClass.Permanent,
        'handler output does not conform to the declared output_schema after one repair ' +
          `retry: ${violations.slice(0, 3).join('; ')}`,
      );
    }
    return output;
  }

  private failed(req: StepRequest, err: CapabilityError, counting?: CountingModel): StepResult {
    const result: StepResult = {
      kind: 'step_result',
      step_id: req.step_id,
      task_id: req.task_id,
      tenant: req.tenant,
      status: 'failed',
      error: err.toProtocol(),
    };
    if (counting !== undefined) result.usage = usageOf(counting);
    return result;
  }
}

function usageOf(counting: CountingModel): Usage {
  // Cache tokens and model id are emitted only when present: exactOptional
  // PropertyTypes + the protocol's additionalProperties:false mean an absent
  // field must be omitted, not sent as undefined/zero. This keeps zero-LLM
  // usage byte-identical to before the cache fields existed.
  return {
    llm_calls: counting.llmCalls,
    input_tokens: counting.inputTokens,
    output_tokens: counting.outputTokens,
    ...(counting.cacheReadTokens > 0 ? { cache_read_tokens: counting.cacheReadTokens } : {}),
    ...(counting.cacheWriteTokens > 0 ? { cache_write_tokens: counting.cacheWriteTokens } : {}),
    ...(counting.model !== undefined ? { model: counting.model } : {}),
  };
}

function violationsOf(validate: ValidateFunction, output: unknown): string[] {
  if (validate(output)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}
