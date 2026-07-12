import process from 'node:process';
import {
  ensureAuditStream,
  AuditPublisher,
  KillSwitchWatcher,
  connectBus,
  createLogger,
  env,
  envInt,
  initTelemetry,
  requireEnv,
} from '@acp/service-kit';
import { buildTokenApp } from './app.js';
import { BusAuthCore } from './bus-auth/core.js';
import { accountFromSeed, curveFromSeed } from './bus-auth/nkeys.js';
import { startBusAuthResponder, type BusAuthResponder } from './bus-auth/responder.js';
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
await ensureAuditStream(nc);

// ADR-0007 broker-time denylist: watch the control KV so delegate/exchange/
// issue refuse revoked identities (halted fleet, suspended agents,
// denylisted principals) in seconds, from memory.
const killSwitch = await KillSwitchWatcher.start(nc, logger);

const issuer = env('ACP_TOKEN_ISSUER', 'https://token.acp.local');
const audit = new AuditPublisher(nc, logger);

const app = await buildTokenApp({
  keys,
  clients: ClientRegistry.fromJson(requireEnv('ACP_TOKEN_CLIENTS')),
  issuer,
  audit,
  logger,
  brokerMaxTaskAgeSeconds: envInt('ACP_BROKER_MAX_TASK_AGE_SECONDS', 86_400),
  killSwitch,
});

// NATS auth callout: mint session-scoped bus identities from platform JWTs.
// The responder lives here (D1) — local KeyStore verification, the existing
// NATS connection, already the availability-critical signer. Enabled only
// when the issuer/xkey seeds are configured; a deployment without them keeps
// static bus users (no callout).
let busAuth: BusAuthResponder | undefined;
const issuerSeed = process.env.ACP_NATS_AUTH_ISSUER_SEED;
const xkeySeed = process.env.ACP_NATS_AUTH_XKEY_SEED;
if (issuerSeed !== undefined && xkeySeed !== undefined) {
  const issuerKp = accountFromSeed(issuerSeed);
  const xkeyKp = curveFromSeed(xkeySeed);
  // tenant claim → NATS account NAME. Derived from the tenant registry
  // (deploy/dev/tenants.json) by run-platform.mjs so the callout mints into
  // exactly the accounts the generated server config defines; a tenant absent
  // from this map is refused at evaluate step 4 (registered-tenants-only).
  const tenantAccounts = JSON.parse(
    env('ACP_BUS_TENANT_ACCOUNTS', '{"acme":"TENANT_ACME"}'),
  ) as Record<string, string>;
  const agentSvcSubjects = env('ACP_BUS_AGENT_SVC_SUBJECTS', 'acp.platform.svc.knowledge.>')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const core = new BusAuthCore(keys, issuer, {
    issuerPublic: issuerKp.getPublicKey(),
    sign: (data) => issuerKp.sign(data),
    tenantAccounts,
    agentSvcSubjects,
    killSwitch,
  });
  busAuth = startBusAuthResponder({
    nc,
    core,
    xkey: xkeyKp,
    issuerPublic: issuerKp.getPublicKey(),
    sign: (data) => issuerKp.sign(data),
    audit,
    logger,
  });
} else {
  logger.warn(
    'ACP_NATS_AUTH_ISSUER_SEED / ACP_NATS_AUTH_XKEY_SEED not set — NATS auth callout disabled (static bus users only)',
  );
}

const port = envInt('ACP_TOKEN_PORT', 7101);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port }, 'token service listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      killSwitch.stop();
      await busAuth?.stop();
      await app.close();
      await nc.drain();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
