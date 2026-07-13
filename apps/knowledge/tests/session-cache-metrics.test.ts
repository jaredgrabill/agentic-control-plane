import { describe, expect, it } from 'vitest';
import { createSessionCacheMetrics } from '../src/session-cache-metrics.js';

describe('createSessionCacheMetrics', () => {
  it('records every outcome without throwing (no-op instruments when no provider)', () => {
    const m = createSessionCacheMetrics();
    expect(() => {
      m.request('hit');
      m.request('miss');
      m.request('stale');
      m.request('expired');
      m.request('disabled');
      m.request('bypassed');
      m.write('ok');
      m.write('too_large');
      m.write('error');
      m.eviction('stale');
      m.eviction('expired');
    }).not.toThrow();
  });
});
