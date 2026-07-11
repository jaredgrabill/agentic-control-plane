import process from 'node:process';
import {
  AuditPublisher,
  connectBus,
  createLogger,
  env,
  envInt,
  initTelemetry,
  requireEnv,
} from '@acp/service-kit';
import { buildTokenApp } from './app.js';
import { ClientRegistry } from './clients.js';
import { loadKeyStore } from './keys.js';

const logger = createLogger('token-service');
const telemetry = initTelemetry('token-service');

const keys = await loadKeyStore({
  privateKeyPem: process.env.ACP_TOKEN_SIGNING_KEY,
  previousPublicKeyPem: process.env.ACP_TOKEN_PREVIOUS_PUBLIC_KEY,
});
if (process.env.ACP_TOKEN_SIGNING_KEY === undefined) {
  logger.warn(
    'no ACP_TOKEN_SIGNING_KEY configured — generated an ephemeral dev signing key; every restart invalidates outstanding tokens',
  );
}

const nc = await connectBus({
  name: 'token-service',
  user: env('ACP_NATS_SERVICE_USER', 'token'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'token-dev-password'),
});

const app = await buildTokenApp({
  keys,
  clients: ClientRegistry.fromJson(requireEnv('ACP_TOKEN_CLIENTS')),
  issuer: env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  audit: new AuditPublisher(nc, logger),
  logger,
});

const port = envInt('ACP_TOKEN_PORT', 7101);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'token service listening');

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
