import { metrics } from '@opentelemetry/api';
import type { SessionCacheMetrics } from './session-cache.js';

/**
 * OTel-backed session cache counters. The headline the dashboard reads is
 * deep-retrievals AVOIDED (hits) and Postgres load shed — not KV latency — so
 * the labels distinguish hit / miss / stale / expired / disabled / bypassed.
 * Without a registered MeterProvider these resolve to no-op instruments, so
 * this is always safe to wire.
 */
export function createSessionCacheMetrics(): SessionCacheMetrics {
  const meter = metrics.getMeter('knowledge');
  const requests = meter.createCounter('acp_session_cache_requests_total', {
    description: 'Session cache lookups by outcome (hit avoids a live retrieval).',
  });
  const writes = meter.createCounter('acp_session_cache_writes_total', {
    description: 'Session cache write-throughs by outcome (ok/too_large/error).',
  });
  const evictions = meter.createCounter('acp_session_cache_evictions_total', {
    description: 'Session cache eager evictions by cause (stale/expired).',
  });
  return {
    request: (result) => {
      requests.add(1, { result });
    },
    write: (result) => {
      writes.add(1, { result });
    },
    eviction: (cause) => {
      evictions.add(1, { cause });
    },
  };
}
