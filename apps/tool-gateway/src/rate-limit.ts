/**
 * Token-bucket rate limiting per (server, tool, tenant). Capacity is the
 * configured burst; refill is per_minute/60 tokens per second, applied
 * lazily on take(). Runs AFTER Cedar in the pipeline so denials never
 * consume quota.
 *
 * LIMITATION (v1, also in the README): buckets are in-memory and
 * per-instance — they reset on restart and are not shared across gateway
 * replicas. Distributed limiting is Phase 3.
 */

import type { RateLimitSpec, ToolServerConfig } from './config.js';

export type TakeResult = { allowed: true } | { allowed: false; retryAfterS: number };

/** The slice the core consumes — tests inject counting fakes. */
export interface RateLimiter {
  take(serverId: string, tool: string, tenant: string): TakeResult;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: ToolServerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  take(serverId: string, tool: string, tenant: string): TakeResult {
    const spec = this.specFor(serverId, tool);
    if (spec === undefined) return { allowed: true }; // ungoverned → not our refusal to make

    const key = `${serverId} ${tool} ${tenant}`;
    const nowMs = this.now();
    const refillPerSecond = spec.per_minute / 60;

    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: spec.burst, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      const elapsedS = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
      bucket.tokens = Math.min(spec.burst, bucket.tokens + elapsedS * refillPerSecond);
      bucket.updatedAtMs = nowMs;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterS: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
    };
  }

  private specFor(serverId: string, tool: string): RateLimitSpec | undefined {
    const entry = this.config.servers.get(serverId);
    if (entry === undefined) return undefined;
    return entry.tool_rate_limits?.[tool] ?? entry.rate_limit;
  }
}
