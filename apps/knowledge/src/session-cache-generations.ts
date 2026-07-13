import { KvWatchInclude, type NatsConnection } from 'nats';
import { openKv, type Logger } from '@acp/service-kit';
import { SESSION_CACHE_BUCKET, genKey } from './session-cache.js';

/** The single watched entry shape the generations view needs (the real KvEntry satisfies it). */
interface GenerationEntry {
  key: string;
  operation: string;
  string(): string;
}

/** The narrow KV surface the watcher needs — the real NATS KV satisfies it, an in-memory fake implements it for tests. */
export interface GenerationWatchKv {
  watch(opts: {
    key: string;
    include: KvWatchInclude;
    initializedFn?: () => void;
  }): Promise<AsyncIterable<GenerationEntry>>;
}

/**
 * In-memory view of source generations (`gen.<tenant>.<source_id>` keys in the
 * session cache bucket), mirroring KillSwitchWatcher: a KV watch seeds the map
 * from history, then keeps it live, and `current()` answers from memory so the
 * retrieval hot path never blocks on a KV round-trip.
 *
 * A cache entry captures the generation of each source it drew from at write
 * time; a mutation to that source bumps its generation (SessionCacheInvalidator),
 * and the next read sees `current() !== captured` and misses. Until the initial
 * history batch drains (`ready`), the generation view is incomplete, so the
 * cache treats itself as disabled and serves live — never serving before the
 * staleness view is seeded is the fail-safe.
 */
export class SessionCacheGenerations {
  private readonly gens = new Map<string, string>();
  private stopped = false;
  private seeded = false;
  private resolveReady!: () => void;
  /** Resolves once the initial history batch has been applied. */
  readonly ready: Promise<void>;

  private constructor(private readonly logger: Logger) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /**
   * Synchronous readiness for the retrieval hot path: false until the initial
   * history batch has drained, so the cache treats itself as disabled and
   * serves live rather than reading against an unseeded generation view.
   */
  isReady(): boolean {
    return this.seeded;
  }

  static async start(nc: NatsConnection, logger: Logger): Promise<SessionCacheGenerations> {
    const kv = await openKv(nc, SESSION_CACHE_BUCKET);
    return SessionCacheGenerations.fromKv(kv, logger);
  }

  /** Wires the watch over an already-open KV. Exposed for unit tests with an in-memory fake. */
  static async fromKv(kv: GenerationWatchKv, logger: Logger): Promise<SessionCacheGenerations> {
    const watcher = new SessionCacheGenerations(logger);
    const iter = await kv.watch({
      key: 'gen.>',
      include: KvWatchInclude.AllHistory,
      // Fired once the historical batch is delivered — the map is now seeded
      // even if there were zero generation keys to replay.
      initializedFn: () => {
        watcher.seeded = true;
        watcher.resolveReady();
        watcher.logger.debug(
          { generations: watcher.gens.size },
          'session cache generation view seeded',
        );
      },
    });
    void (async () => {
      for await (const entry of iter) {
        if (watcher.stopped) break;
        if (entry.operation === 'DEL' || entry.operation === 'PURGE') {
          watcher.gens.delete(entry.key);
          continue;
        }
        watcher.gens.set(entry.key, entry.string());
      }
    })();
    return watcher;
  }

  /**
   * The current generation of a source, or `'0'` when none has been recorded
   * (an unmutated source, or a memory-reset bucket). `'0'` never equals a
   * captured non-zero generation, so a wiped view reads as stale, not fresh.
   */
  current(tenant: string, sourceId: string): string {
    return this.gens.get(genKey(tenant, sourceId)) ?? '0';
  }

  stop(): void {
    this.stopped = true;
  }
}
