import process from 'node:process';
import {
  JwtVerifier,
  connectBus,
  createLogger,
  ensureAuditStream,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import pg from 'pg';
import { buildAuditApp, resolveRetentionHotDays } from './app.js';
import { runConsumer } from './loop.js';
import { PgAuditStore } from './store.js';

const logger = createLogger('audit');
const telemetry = initTelemetry('audit');

const pool = new pg.Pool({
  connectionString: env('ACP_DATABASE_URL', 'postgres://acp:acp-dev-password@localhost:5432/acp'),
});
const store = new PgAuditStore(pool);
await store.migrate();

// Fail-closed governance: refuse to boot if hot retention is below the
// six-month floor (EU AI Act Art.19). Resolved before listening.
const retentionHotDays = resolveRetentionHotDays(process.env.ACP_AUDIT_RETENTION_HOT_DAYS);

const nc = await connectBus({
  name: 'audit',
  user: env('ACP_NATS_SERVICE_USER', 'audit'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'audit-dev-password'),
});
await ensureAuditStream(nc);

const app = buildAuditApp({
  verifier: new JwtVerifier(
    { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
    env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  ),
  store,
  logger,
  retentionHotDays,
});

const port = envInt('ACP_AUDIT_PORT', 7104);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'audit service listening');

const consumerDone = runConsumer(nc, store, logger).catch((err: unknown) => {
  logger.error({ err }, 'audit consumer stopped unexpectedly');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await nc.drain();
      await consumerDone;
      await pool.end();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
