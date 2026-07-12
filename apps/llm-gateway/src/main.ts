/** LLM Gateway bootstrap (dev profile). Coverage-excluded; E2E drives it. */

import process from 'node:process';
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
import { RegistryAllowlist } from './allowlist.js';
import { buildLlmGatewayApp } from './app.js';
import { loadModelClasses } from './classes.js';
import { LlmGatewayCore } from './core.js';
import { buildProviders } from './providers/index.js';

const logger = createLogger('llm-gateway');
const telemetry = initTelemetry('llm-gateway');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const nc = await connectBus({
  name: 'llm-gateway',
  user: env('ACP_NATS_SERVICE_USER', 'llm-gateway'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'llm-gateway-dev-password'),
});
await ensureAuditStream(nc);
const audit = new AuditPublisher(nc, logger);
const killSwitch = await KillSwitchWatcher.start(nc, logger);

const verifier = new JwtVerifier(
  { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
  env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
);

const config = loadModelClasses(
  env('ACP_MODEL_CLASSES', join(repoRoot, 'deploy', 'dev', 'model-classes.json')),
);
const providers = buildProviders(config);

const allowlist = new RegistryAllowlist({
  registryUrl: env('ACP_REGISTRY_URL', 'http://localhost:7102'),
  tokenUrl: env('ACP_TOKEN_URL', 'http://localhost:7101'),
  clientId: env('ACP_LLM_GATEWAY_CLIENT_ID', 'svc-llm-gateway'),
  clientSecret: env('ACP_LLM_GATEWAY_CLIENT_SECRET', 'llm-gateway-dev-secret'),
});

const core = new LlmGatewayCore({ config, providers, allowlist, audit, killSwitch, logger });
const app = buildLlmGatewayApp({ core, verifier, logger });

const port = envInt('ACP_LLM_GATEWAY_PORT', 7107);
await app.listen({ port, host: '0.0.0.0' });
logger.info(
  { port, version: config.version, classes: [...config.classes.keys()] },
  'llm gateway listening',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      killSwitch.stop();
      await app.close();
      await nc.drain();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
