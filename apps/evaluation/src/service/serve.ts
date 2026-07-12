import { readFileSync } from 'node:fs';
import process from 'node:process';
import { loadOnlineEvalConfig } from '@acp/online-eval';
import {
  AuditPublisher,
  JwtVerifier,
  connectBus,
  createLogger,
  ensureAuditStream,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import pg from 'pg';
import { createActionClients } from './actions.js';
import { buildEvalService } from './app.js';
import { PgScoresStore } from './store.js';

/** Boots the evaluation service (serve mode): scores store + enforcement brain on port 7108. */
export async function startEvalService(): Promise<void> {
  const logger = createLogger('evaluation');
  const telemetry = initTelemetry('evaluation');

  const configPath = env('ACP_ONLINE_EVAL', '');
  if (configPath === '') {
    throw new Error('ACP_ONLINE_EVAL (path to online-eval.json) is required for serve mode');
  }
  const config = loadOnlineEvalConfig(readFileSync(configPath, 'utf8'));

  const pool = new pg.Pool({
    connectionString: env('ACP_DATABASE_URL', 'postgres://acp:acp-dev-password@localhost:5432/acp'),
  });
  const store = new PgScoresStore(pool);
  await store.migrate();

  const nc = await connectBus({
    name: 'evaluation',
    user: env('ACP_NATS_SERVICE_USER', 'evaluation'),
    password: env('ACP_NATS_SERVICE_PASSWORD', 'evaluation-dev-password'),
  });
  await ensureAuditStream(nc);

  const { actions, agentMeta } = createActionClients({
    tokenUrl: env('ACP_TOKEN_URL', 'http://localhost:7101'),
    registryUrl: env('ACP_REGISTRY_URL', 'http://localhost:7102'),
    gatewayUrl: env('ACP_GATEWAY_URL', 'http://localhost:7100'),
    clientId: env('ACP_EVALUATION_CLIENT_ID', 'svc-evaluation'),
    clientSecret: env('ACP_EVALUATION_CLIENT_SECRET', 'evaluation-dev-secret'),
    sloDefault: config.budget.slo_default,
    logger,
  });

  const app = buildEvalService({
    verifier: new JwtVerifier(
      { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
      env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
    ),
    store,
    config,
    audit: new AuditPublisher(nc, logger),
    actions,
    agentMeta,
    logger,
  });

  const port = envInt('ACP_EVALUATION_PORT', 7108);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'evaluation service listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await pool.end();
        await nc.drain();
        await telemetry.shutdown();
        process.exit(0);
      })();
    });
  }
}
