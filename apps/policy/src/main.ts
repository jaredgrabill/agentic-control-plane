import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ensureAuditStream,
  AuditPublisher,
  JwtVerifier,
  connectBus,
  createLogger,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import { buildPolicyApp } from './app.js';
import { loadBundle } from './bundle.js';
import { CedarPdp } from './pdp.js';

const logger = createLogger('policy');
const telemetry = initTelemetry('policy');

const defaultBundleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'policies',
);
const bundle = loadBundle(env('ACP_POLICY_BUNDLE_DIR', defaultBundleDir));
logger.info(
  { bundle_version: bundle.version, policies: Object.keys(bundle.policies) },
  'policy bundle loaded',
);

const nc = await connectBus({
  name: 'policy',
  user: env('ACP_NATS_SERVICE_USER', 'policy'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'policy-dev-password'),
});
await ensureAuditStream(nc);

const app = buildPolicyApp({
  verifier: new JwtVerifier(
    { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
    env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  ),
  pdp: new CedarPdp(bundle, logger),
  audit: new AuditPublisher(nc, logger),
  logger,
});

const port = envInt('ACP_POLICY_PORT', 7103);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'policy service listening');

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
