import { createLogger } from '@acp/service-kit';
import type { KvWatchInclude } from 'nats';
import { describe, expect, it } from 'vitest';
import { SessionCacheGenerations, type GenerationWatchKv } from '../src/session-cache-generations.js';

const logger = createLogger('session-cache-generations-test');

interface Entry {
  key: string;
  operation: string;
  string(): string;
}

/** Controllable KV watch fake: seed history, then push live edits and close. */
class FakeWatchKv implements GenerationWatchKv {
  private readonly history: Entry[] = [];
  private readonly live: Entry[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  seed(key: string, value: string): void {
    this.history.push(mk(key, value, 'PUT'));
  }
  push(key: string, value: string, operation = 'PUT'): void {
    this.live.push(mk(key, value, operation));
    this.notify?.();
  }
  close(): void {
    this.closed = true;
    this.notify?.();
  }

  watch(opts: {
    key: string;
    include: KvWatchInclude;
    initializedFn?: () => void;
  }): Promise<AsyncIterable<Entry>> {
    const self = this;
    async function* gen(): AsyncGenerator<Entry> {
      for (const e of self.history) yield e;
      opts.initializedFn?.();
      while (!self.closed) {
        while (self.live.length > 0) yield self.live.shift() as Entry;
        if (self.closed) break;
        await new Promise<void>((resolve) => {
          self.notify = resolve;
        });
      }
    }
    return Promise.resolve(gen());
  }
}

function mk(key: string, value: string, operation: string): Entry {
  return { key, operation, string: () => value };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('SessionCacheGenerations', () => {
  it('resolves ready even when there is no generation history', async () => {
    const kv = new FakeWatchKv();
    const w = await SessionCacheGenerations.fromKv(kv, logger);
    await w.ready; // must resolve
    expect(w.current('acme', 'policy-docs')).toBe('0');
    kv.close();
    w.stop();
  });

  it('seeds current() from watched history', async () => {
    const kv = new FakeWatchKv();
    kv.seed('gen.acme.policy-docs', '4');
    const w = await SessionCacheGenerations.fromKv(kv, logger);
    await w.ready;
    expect(w.current('acme', 'policy-docs')).toBe('4');
    expect(w.current('acme', 'other')).toBe('0');
    expect(w.current('globex', 'policy-docs')).toBe('0');
    kv.close();
    w.stop();
  });

  it('reflects a live generation bump after ready', async () => {
    const kv = new FakeWatchKv();
    const w = await SessionCacheGenerations.fromKv(kv, logger);
    await w.ready;
    expect(w.current('acme', 'policy-docs')).toBe('0');
    kv.push('gen.acme.policy-docs', '9');
    await tick();
    expect(w.current('acme', 'policy-docs')).toBe('9');
    kv.close();
    w.stop();
  });

  it('drops a generation on delete (view resets to 0 → reads as stale)', async () => {
    const kv = new FakeWatchKv();
    kv.seed('gen.acme.policy-docs', '4');
    const w = await SessionCacheGenerations.fromKv(kv, logger);
    await w.ready;
    kv.push('gen.acme.policy-docs', '', 'DEL');
    await tick();
    expect(w.current('acme', 'policy-docs')).toBe('0');
    kv.close();
    w.stop();
  });
});
