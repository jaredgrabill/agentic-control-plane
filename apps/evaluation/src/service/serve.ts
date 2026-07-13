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
import type { TenantBudgetCaps } from './budget.js';
import { PgBudgetLedger, startBudgetLedgerConsumer, startBudgetReaper } from './budget-ledger.js';
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

  // Phase 4 item 1: the per-tenant budget ledger. Caps come from platform
  // config (deploy/dev/tenant-budgets.json) — NEVER from a request — and are
  // upserted for the current period at boot; a tenant absent from the file is
  // uncapped. The durable task.completed consumer books actual spend and the
  // reaper releases reservations of tasks that never completed.
  const ledger = new PgBudgetLedger(pool);
  const capsPath = env('ACP_TENANT_BUDGETS', '');
  let caps: TenantBudgetCaps | undefined;
  if (capsPath !== '') {
    caps = JSON.parse(readFileSync(capsPath, 'utf8')) as TenantBudgetCaps;
    await ledger.upsertCaps(caps);
    logger.info({ tenants: Object.keys(caps) }, 'tenant budget caps applied for current period');
  } else {
    logger.warn('ACP_TENANT_BUDGETS not set — no tenant budget caps (all tenants uncapped)');
  }
  const ledgerConsumer = await startBudgetLedgerConsumer(nc, ledger, logger);
  // The reaper re-upserts caps every tick so the current period's cap rows
  // survive a UTC month rollover (else capped tenants run uncapped until a
  // restart re-runs the boot upsert above).
  const reaper = startBudgetReaper(ledger, logger, {
    maxAgeSeconds: envInt('ACP_TASK_RESERVATION_MAX_AGE_SECONDS', 86_400),
    intervalMs: envInt('ACP_BUDGET_REAPER_INTERVAL_SECONDS', 300) * 1000,
    caps,
  });

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
    budget: ledger,
    logger,
  });

  const port = envInt('ACP_EVALUATION_PORT', 7108);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'evaluation service listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        reaper.stop();
        ledgerConsumer.stop();
        await app.close();
        await pool.end();
        await nc.drain();
        await telemetry.shutdown();
        process.exit(0);
      })();
    });
  }
}
