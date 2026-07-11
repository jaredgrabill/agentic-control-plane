/**
 * ModelClient: the only door to LLMs (paved-road.md). Manifests declare model
 * classes, never model IDs; routing/caching/budget live behind this seam. The
 * alpha ships the FakeModel test seam (testing.md: LLM calls are faked at the
 * SDK seam) — provider routing through the LLM gateway lands in Phase 2.
 */

import { CapabilityError, ErrorClass } from './errors.js';

/** One model completion; token counts feed the StepResult usage block. */
export interface ModelResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

/** The seam every handler-visible model implements. */
export interface ModelClient {
  /** `maxTokens` defaults to 1024, matching the Python SDK. */
  complete(prompt: string, options?: { maxTokens?: number }): Promise<ModelResponse>;
}

/** A scripted step: string, response, error, or prompt → text function. */
export type FakeModelStep = string | ModelResponse | Error | ((prompt: string) => string);

/**
 * Scripted model responses for deterministic handler tests.
 *
 * Feed it strings, ModelResponses, callables (prompt → response), or errors —
 * exhausting the script rejects, because a handler making more LLM calls than
 * its test scripted is a behavior change the test must catch, not absorb.
 */
export class FakeModel implements ModelClient {
  readonly script: FakeModelStep[];
  readonly calls: string[] = [];

  constructor(script: FakeModelStep[] = []) {
    this.script = script;
  }

  complete(prompt: string, _options?: { maxTokens?: number }): Promise<ModelResponse> {
    this.calls.push(prompt);
    const step = this.script.shift();
    if (step === undefined) {
      return Promise.reject(
        new CapabilityError(
          ErrorClass.Permanent,
          `FakeModel script exhausted after ${this.calls.length - 1} calls — ` +
            'the handler made more model calls than the test scripted',
        ),
      );
    }
    if (step instanceof Error) return Promise.reject(step);
    const resolved = typeof step === 'function' ? step(prompt) : step;
    if (typeof resolved === 'string') {
      return Promise.resolve({
        text: resolved,
        outputTokens: Math.max(1, Math.floor(resolved.length / 4)),
      });
    }
    return Promise.resolve(resolved);
  }
}
