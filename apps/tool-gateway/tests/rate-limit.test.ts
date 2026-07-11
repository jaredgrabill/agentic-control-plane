import { describe, expect, it } from 'vitest';
import type { ToolServerConfig, ToolServerEntry } from '../src/config.js';
import { TokenBucketLimiter } from '../src/rate-limit.js';

function configWith(entry: Partial<ToolServerEntry>): ToolServerConfig {
  const full: ToolServerEntry = {
    id: 'cloud-estate',
    url: 'http://localhost:7301/mcp',
    auth: { mode: 'static-headers', headers: {} },
    tools: { inventory_search: { scope: 'cloud:inventory:read' } },
    rate_limit: { per_minute: 60, burst: 3 },
    timeout_ms: 15000,
    ...entry,
  };
  return { servers: new Map([[full.id, full]]) };
}

/** An injectable millisecond clock the tests advance by hand. */
function clock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('TokenBucketLimiter', () => {
  it('allows the burst, then refuses with retryAfterS >= 1', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter(configWith({}), c.now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.take('cloud-estate', 'inventory_search', 'acme')).toEqual({ allowed: true });
    }
    const refused = limiter.take('cloud-estate', 'inventory_search', 'acme');
    expect(refused.allowed).toBe(false);
    // 60/min = 1 token/s: exactly 1 second until the next token.
    expect(refused).toMatchObject({ retryAfterS: 1 });
  });

  it('refills at per_minute/60 per second, capped at the burst', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter(configWith({}), c.now);
    for (let i = 0; i < 3; i++) limiter.take('cloud-estate', 'inventory_search', 'acme');
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(false);

    c.advance(1_000); // one token back
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(true);
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(false);

    c.advance(3_600_000); // an hour — capped at burst 3, not 60
    for (let i = 0; i < 3; i++) {
      expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(true);
    }
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(false);
  });

  it('rounds slow refills up to whole seconds (ceil, minimum 1)', () => {
    const c = clock();
    // 6/min = one token every 10s.
    const limiter = new TokenBucketLimiter(
      configWith({ rate_limit: { per_minute: 6, burst: 1 } }),
      c.now,
    );
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(true);
    c.advance(2_500); // 0.25 tokens refilled → 0.75 missing → 7.5s → ceil 8
    const refused = limiter.take('cloud-estate', 'inventory_search', 'acme');
    expect(refused).toMatchObject({ allowed: false, retryAfterS: 8 });
  });

  it('isolates buckets by tenant and by tool', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter(
      configWith({
        rate_limit: { per_minute: 60, burst: 1 },
        tools: {
          inventory_search: { scope: 'cloud:inventory:read' },
          cost_report: { scope: 'cloud:cost:read' },
        },
      }),
      c.now,
    );
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(true);
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(false);
    // A different tenant and a different tool each have their own bucket.
    expect(limiter.take('cloud-estate', 'inventory_search', 'globex').allowed).toBe(true);
    expect(limiter.take('cloud-estate', 'cost_report', 'acme').allowed).toBe(true);
  });

  it('honors per-tool overrides over the server default', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter(
      configWith({
        rate_limit: { per_minute: 60, burst: 10 },
        tool_rate_limits: { inventory_search: { per_minute: 60, burst: 1 } },
        tools: {
          inventory_search: { scope: 'cloud:inventory:read' },
          cost_report: { scope: 'cloud:cost:read' },
        },
      }),
      c.now,
    );
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(true);
    expect(limiter.take('cloud-estate', 'inventory_search', 'acme').allowed).toBe(false);
    // cost_report rides the server default burst of 10.
    for (let i = 0; i < 10; i++) {
      expect(limiter.take('cloud-estate', 'cost_report', 'acme').allowed).toBe(true);
    }
  });

  it('lets unknown servers pass — refusing them is the governed lookup, not the limiter', () => {
    const limiter = new TokenBucketLimiter(configWith({}), clock().now);
    expect(limiter.take('ghost', 'tool', 'acme')).toEqual({ allowed: true });
  });
});
