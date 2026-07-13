import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  ensureAuditStream,
  AuditPublisher,
  JwtVerifier,
  KillSwitchControl,
  connectBus,
  createLogger,
  env,
  envInt,
  initTelemetry,
} from '@acp/service-kit';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8 } from 'jose';
import pg from 'pg';
import { buildRegistryApp } from './app.js';
import { NatsRegistryAnnouncer } from './bus.js';
import { PgRegistryStore } from './store.js';

const logger = createLogger('registry');
const telemetry = initTelemetry('registry');

// Card-signing key: PKCS8 PEM in ACP_REGISTRY_SIGNING_KEY, or an ephemeral
// dev key (cards re-sign at every registration, so restarts only invalidate
// signature verification of cards signed by the previous process).
const keyPem = process.env.ACP_REGISTRY_SIGNING_KEY;
const { privateKey, publicKey } =
  keyPem !== undefined
    ? { privateKey: await importPKCS8(keyPem, 'EdDSA', { extractable: true }), publicKey: null }
    : await generateKeyPair('EdDSA', { extractable: true });
if (keyPem === undefined) {
  logger.warn('no ACP_REGISTRY_SIGNING_KEY configured — using an ephemeral dev signing key');
}
const publicJwk = { ...(await exportJWK(publicKey ?? privateKey)) };
delete publicJwk.d;
const kid = await calculateJwkThumbprint(publicJwk);

const pool = new pg.Pool({
  connectionString: env('ACP_DATABASE_URL', 'postgres://acp:acp-dev-password@localhost:5432/acp'),
});
const store = new PgRegistryStore(pool);
await store.migrate();

const nc = await connectBus({
  name: 'registry',
  user: env('ACP_NATS_SERVICE_USER', 'registry'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'registry-dev-password'),
});
await ensureAuditStream(nc);

// A2A exposure allowlist (item 3): PLATFORM deploy config, never
// agent-authored. No file configured means nothing is exported — the
// secure default keeps existing deployments unchanged.
const exposurePath = process.env.ACP_A2A_EXPOSURE;
let a2aExposure = new Set<string>();
if (exposurePath !== undefined && exposurePath !== '') {
  const parsed = JSON.parse(readFileSync(exposurePath, 'utf8')) as { exposed?: unknown };
  if (!Array.isArray(parsed.exposed) || parsed.exposed.some((id) => typeof id !== 'string')) {
    throw new Error(`${exposurePath}: expected {"exposed": [agent ids]}`);
  }
  a2aExposure = new Set(parsed.exposed as string[]);
  logger.info({ exposed: [...a2aExposure] }, 'a2a card export exposure allowlist loaded');
}

const app = buildRegistryApp({
  verifier: new JwtVerifier(
    { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
    env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
  ),
  store,
  signingKey: { kid, privateKey },
  jwks: { keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }] },
  announcer: await NatsRegistryAnnouncer.connect(nc, logger),
  control: await KillSwitchControl.open(nc),
  a2a: {
    exposure: a2aExposure,
    edgeBaseUrl: env('ACP_A2A_EDGE_URL', 'http://localhost:7100'),
    providerOrg: env('ACP_A2A_PROVIDER_ORG', 'Agentic Control Plane (dev)'),
    tokenUrl: env('ACP_TOKEN_URL', 'http://localhost:7101'),
  },
  audit: new AuditPublisher(nc, logger),
  logger,
});

const port = envInt('ACP_REGISTRY_PORT', 7102);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'registry listening');

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
