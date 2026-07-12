import process from 'node:process';
import {
  ensureAuditStream,
  AuditPublisher,
  JwtVerifier,
  KillSwitchWatcher,
  connectBus,
  createLogger,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import { buildGatewayApp } from './app.js';
import { FleetCanceller } from './fleet-canceller.js';
import { connectTemporal } from './temporal.js';

const logger = createLogger('gateway');
const telemetry = initTelemetry('gateway');

const nc = await connectBus({
  name: 'gateway',
  user: env('ACP_NATS_SERVICE_USER', 'gateway'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'gateway-dev-password'),
});
await ensureAuditStream(nc);

const temporal = await connectTemporal();
const killSwitch = await KillSwitchWatcher.start(nc, logger);
const audit = new AuditPublisher(nc, logger);

const app = buildGatewayApp({
  verifier: new JwtVerifier(
    { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
    env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  ),
  starter: temporal.starter,
  approvals: temporal.approvals,
  deployments: temporal.deployments,
  killSwitch,
  audit,
  logger,
});

// Tier-3: on a fleet halt, sweep and cancel every in-flight TaskWorkflow so each
// drains and unwinds. Reacts to the flip via the shared watcher; re-arms at
// startup if the halt is already active (restart survival).
new FleetCanceller({ watcher: killSwitch, client: temporal.fleet, audit, logger }).start();

const port = envInt('ACP_GATEWAY_PORT', 7100);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'gateway listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await nc.drain();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
