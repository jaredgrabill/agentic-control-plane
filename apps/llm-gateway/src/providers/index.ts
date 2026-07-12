/**
 * Provider construction from the model-classes config. Secrets resolve
 * here, at startup: an anthropic provider whose api_key_env is unset is a
 * boot error, never an empty-string key discovered at request time. The
 * optional per-provider RPM bucket (in-memory, single-instance) wraps the
 * adapter; it is OFF unless the config names an rpm.
 */

import type { ModelClassConfig } from '../classes.js';
import { AnthropicProvider } from './anthropic.js';
import { DevProvider } from './dev.js';
import {
  ProviderFault,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderRequest,
} from './types.js';

export function buildProviders(
  config: ModelClassConfig,
  env: Record<string, string | undefined> = process.env,
): Map<string, ProviderAdapter> {
  const providers = new Map<string, ProviderAdapter>();
  for (const [name, spec] of config.providers) {
    if (spec.type === 'dev') {
      // The dev-echo provider honours a `[[dev-llm]]` directive that scripts
      // its output verbatim. Reachable in production it would let an agent
      // forge its own judge score (online-eval self-inflation). Refuse to
      // construct it under NODE_ENV=production unless a sandbox explicitly
      // opts in with ACP_ALLOW_DEV_PROVIDER — fail closed at boot, never at
      // request time.
      if (env.NODE_ENV === 'production' && !isTruthyFlag(env.ACP_ALLOW_DEV_PROVIDER)) {
        throw new Error(
          `provider ${name}: the dev provider must not be constructed under ` +
            'NODE_ENV=production — its scripted-output directive lets a caller forge ' +
            'completions (and self-score the judge). Set ACP_ALLOW_DEV_PROVIDER=1 only ' +
            'in a non-production sandbox to override.',
        );
      }
      providers.set(name, new DevProvider());
      continue;
    }
    const apiKey = env[spec.api_key_env];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        `provider ${name}: environment variable ${spec.api_key_env} is not set — ` +
          'a provider credential must never silently resolve to the empty string',
      );
    }
    const adapter = new AnthropicProvider({ apiKey, baseUrl: spec.base_url });
    providers.set(
      name,
      spec.rpm !== undefined ? new RpmLimitedAdapter(name, adapter, spec.rpm) : adapter,
    );
  }
  return providers;
}

/** A flag is "set" when it carries any value other than empty / 0 / false. */
function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Token bucket at `rpm` capacity refilling continuously — the same lazy
 * refill the tool gateway's TokenBucketLimiter uses. Exhaustion surfaces
 * as a rate_limited ProviderFault, so the failover loop treats a local
 * cap exactly like an upstream 429.
 */
export class RpmLimitedAdapter implements ProviderAdapter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly name: string,
    private readonly inner: ProviderAdapter,
    private readonly rpm: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = rpm;
    this.lastRefill = this.now();
  }

  complete(model: string, request: ProviderRequest): Promise<ProviderCompletion> {
    const at = this.now();
    const elapsedS = Math.max(0, (at - this.lastRefill) / 1000);
    this.tokens = Math.min(this.rpm, this.tokens + elapsedS * (this.rpm / 60));
    this.lastRefill = at;
    if (this.tokens < 1) {
      const retryAfterS = Math.ceil((1 - this.tokens) / (this.rpm / 60));
      return Promise.reject(
        new ProviderFault(
          'rate_limited',
          `provider ${this.name} is at its local ${this.rpm} rpm cap`,
          retryAfterS,
        ),
      );
    }
    this.tokens -= 1;
    return this.inner.complete(model, request);
  }
}

export {
  AnthropicProvider,
  ANTHROPIC_VERSION,
  CACHE_CONTROL_MIN_TOKENS,
  buildRequestBody,
} from './anthropic.js';
export {
  DEV_DIRECTIVE,
  DEV_ECHO_MODEL,
  DEV_FAIL_429_MODEL,
  DEV_FAIL_500_MODEL,
  DevProvider,
} from './dev.js';
export {
  ProviderFault,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderFaultKind,
  type ProviderRequest,
} from './types.js';
