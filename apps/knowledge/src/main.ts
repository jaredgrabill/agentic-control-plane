import process from 'node:process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuditPublisher,
  JwtVerifier,
  KillSwitchWatcher,
  connectBus,
  createLogger,
  ensureAuditStream,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import pg from 'pg';
import { buildKnowledgeApp } from './app.js';
import { serveSearchOverBus } from './bus.js';
import { FixtureConnector } from './connector.js';
import { HashEmbedder } from './embedding.js';
import { createIngestionActivities } from './ingestion-activities.js';
import type { SourceIngestionResult } from './ingestion-workflows.js';
import { SearchService, type PolicyDecision, type SearchDeps } from './search.js';
import { SessionCacheGenerations } from './session-cache-generations.js';
import { runSessionCacheInvalidator } from './session-cache-invalidator.js';
import { createSessionCacheMetrics } from './session-cache-metrics.js';
import { SessionContextCache, ensureSessionCacheBucket } from './session-cache.js';
import { PgKnowledgeStore } from './store.js';

const logger = createLogger('knowledge');
const telemetry = initTelemetry('knowledge');
const require = createRequire(import.meta.url);

const INGEST_QUEUE = 'acp-ingest';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pool = new pg.Pool({
  connectionString: env('ACP_DATABASE_URL', 'postgres://acp:acp-dev-password@localhost:5432/acp'),
});
const store = new PgKnowledgeStore(pool);
await store.migrate();

const nc = await connectBus({
  name: 'knowledge',
  user: env('ACP_NATS_SERVICE_USER', 'knowledge'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'knowledge-dev-password'),
});
await ensureAuditStream(nc);

const embedder = new HashEmbedder();
const connector = new FixtureConnector(
  env('ACP_CORPUS_MANIFEST', join(repoRoot, 'fixtures', 'acme-corp', 'corpus.json')),
);
const audit = new AuditPublisher(nc, logger);
const verifier = new JwtVerifier(
  { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
  env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
);

const policyUrl = env('ACP_POLICY_URL', 'http://localhost:7103');
const tokenUrl = env('ACP_TOKEN_URL', 'http://localhost:7101');
const clientId = env('ACP_KNOWLEDGE_CLIENT_ID', 'svc-knowledge');
const clientSecret = env('ACP_KNOWLEDGE_CLIENT_SECRET', 'knowledge-dev-secret');

// Session context cache (default OFF). When enabled: a MEMORY-storage KV
// bucket, a generation watcher + durable lineage-invalidation consumer, and a
// kill-switch watcher so a fleet/tenant halt or principal denial bypasses the
// cache. Authorization is never cached — SearchService still verifies + Cedar-
// gates every call and emits retrieval.served on a hit.
const sessionCacheEnabled = env('ACP_SESSION_CACHE_ENABLED', 'false') === 'true';
let sessionCacheDeps: Pick<
  SearchDeps,
  'cache' | 'gens' | 'killSwitch' | 'cacheTtlMs' | 'cacheMetrics'
> = {};
let sessionCacheGenerations: SessionCacheGenerations | undefined;
let sessionCacheKillSwitch: KillSwitchWatcher | undefined;
if (sessionCacheEnabled) {
  const maxValueBytes = envInt('ACP_SESSION_CACHE_MAX_VALUE_BYTES', 262_144);
  const maxBytes = envInt('ACP_SESSION_CACHE_MAX_BYTES', 64 * 1024 * 1024);
  const cacheTtlMs = envInt('ACP_SESSION_CACHE_TTL_MS', 60_000);
  // Bucket ttl=0: the generation keys live in this bucket and must NOT expire,
  // so per-entry expiry is enforced on read (min(now+ttl, token exp)) and the
  // bucket is bounded by max_bytes, not a bucket-wide TTL.
  const cacheKv = await ensureSessionCacheBucket(nc, { maxValueBytes, maxBytes, ttlMs: 0 });
  sessionCacheGenerations = await SessionCacheGenerations.start(nc, logger);
  sessionCacheKillSwitch = await KillSwitchWatcher.start(nc, logger);
  void runSessionCacheInvalidator(nc, cacheKv, logger).catch((err: unknown) => {
    logger.error({ err }, 'session cache invalidator stopped');
  });
  sessionCacheDeps = {
    cache: new SessionContextCache(cacheKv, maxValueBytes, logger),
    gens: sessionCacheGenerations,
    killSwitch: sessionCacheKillSwitch,
    cacheTtlMs,
    cacheMetrics: createSessionCacheMetrics(),
  };
  logger.info({ maxValueBytes, maxBytes, cacheTtlMs }, 'session context cache enabled');
}

const search = new SearchService({
  verifier,
  store,
  embedder,
  policy: {
    async authorize(request) {
      const tokenRes = await fetch(`${tokenUrl}/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          audience: 'acp:policy',
          scope: 'policy:decide',
        }),
      });
      if (!tokenRes.ok) {
        throw new Error(`token service refused knowledge client: ${tokenRes.status}`);
      }
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const res = await fetch(`${policyUrl}/v1/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(`policy service failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as PolicyDecision;
    },
  },
  audit,
  logger,
  ...sessionCacheDeps,
});

// Temporal: worker for ingestion activities + client to start ingestions.
const temporalAddress = env('ACP_TEMPORAL_ADDRESS', 'localhost:7233');
const temporalNamespace = env('ACP_TEMPORAL_NAMESPACE', 'default');
const workerConnection = await NativeConnection.connect({ address: temporalAddress });
const worker = await Worker.create({
  connection: workerConnection,
  namespace: temporalNamespace,
  taskQueue: INGEST_QUEUE,
  workflowsPath: require.resolve('./ingestion-workflows.js'),
  activities: {
    ...createIngestionActivities({
      connector,
      store,
      embedder,
      audit,
      tenant: connector.tenant,
      logger,
    }),
  },
});
const workerDone = worker.run();

const client = new Client({
  connection: await Connection.connect({ address: temporalAddress }),
  namespace: temporalNamespace,
});

const app = buildKnowledgeApp({
  search,
  verifier,
  ingest: {
    async ingestSource(sourceId) {
      const result = await client.workflow.execute<(s: string) => Promise<SourceIngestionResult>>(
        'IngestSourceWorkflow',
        {
          taskQueue: INGEST_QUEUE,
          workflowId: `ingest-${sourceId}-${Date.now()}`,
          args: [sourceId],
        },
      );
      return {
        documents: result.documents.length,
        indexed: result.documents.reduce((sum, d) => sum + d.indexed, 0),
      };
    },
  },
  logger,
});
serveSearchOverBus(nc, search, logger);

const port = envInt('ACP_KNOWLEDGE_PORT', 7105);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port, ingestQueue: INGEST_QUEUE }, 'knowledge service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      worker.shutdown();
      await workerDone;
      sessionCacheGenerations?.stop();
      sessionCacheKillSwitch?.stop();
      await nc.drain();
      await pool.end();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
