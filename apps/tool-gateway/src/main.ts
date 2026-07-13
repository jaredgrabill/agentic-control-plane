/** Tool Gateway bootstrap (dev profile). Coverage-excluded; E2E drives it. */

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
import { buildToolGatewayApp } from './app.js';
import { DevCredentialBroker } from './broker.js';
import { loadToolServerCatalog, loadToolServerConfig } from './config.js';
import { ToolGatewayCore } from './core.js';
import { HttpPolicyClient } from './policy-client.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { UpstreamPool, type UpstreamBinding } from './upstream.js';

const logger = createLogger('tool-gateway');
const telemetry = initTelemetry('tool-gateway');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Client-credentials mint for the gateway's own registry:read catalog reads. */
async function mintRegistryReadToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(`${tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'acp:registry',
      scope: 'registry:read',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `tool-gateway could not mint a registry:read token (http ${res.status}) — ` +
        'enabling ACP_TOOL_CATALOG_URL requires granting svc-tool-gateway registry:read',
    );
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

const nc = await connectBus({
  name: 'tool-gateway',
  user: env('ACP_NATS_SERVICE_USER', 'tool-gateway'),
  password: env('ACP_NATS_SERVICE_PASSWORD', 'tool-gateway-dev-password'),
});
await ensureAuditStream(nc);
const audit = new AuditPublisher(nc, logger);
const killSwitch = await KillSwitchWatcher.start(nc, logger);

const verifier = new JwtVerifier(
  { jwksUrl: env('ACP_JWKS_URL', 'http://localhost:7101/.well-known/jwks.json') },
  env('ACP_TOKEN_ISSUER', 'https://token.acp.local'),
);

const tokenUrl = env('ACP_TOKEN_URL', 'http://localhost:7101');
const clientId = env('ACP_TOOL_GATEWAY_CLIENT_ID', 'svc-tool-gateway');
const clientSecret = env('ACP_TOOL_GATEWAY_CLIENT_SECRET', 'tool-gateway-dev-secret');

// Item 3 (SF3): the tool-server config source. ACP_TOOL_CATALOG_URL is OFF by
// default, so the gateway keeps loading the static file and dev/CI behavior is
// unchanged. When set, the config comes from the registry catalog instead — the
// gateway mints a registry:read token for itself to read it (enabling the flag
// therefore requires granting svc-tool-gateway registry:read).
const catalogUrl = process.env.ACP_TOOL_CATALOG_URL;
const config =
  catalogUrl !== undefined && catalogUrl !== ''
    ? await loadToolServerCatalog({
        registryUrl: catalogUrl,
        token: await mintRegistryReadToken(tokenUrl, clientId, clientSecret),
      })
    : loadToolServerConfig(env('ACP_TOOL_SERVERS', join(repoRoot, 'deploy', 'dev', 'tool-servers.json')));

const policy = new HttpPolicyClient({
  policyUrl: env('ACP_POLICY_URL', 'http://localhost:7103'),
  tokenUrl,
  clientId,
  clientSecret,
});
const broker = new DevCredentialBroker({ tokenUrl, clientId, clientSecret });
const bindings: Record<string, UpstreamBinding> = {};
for (const [id, entry] of config.servers) {
  bindings[id] = { url: entry.url };
}
const upstreams = new UpstreamPool(bindings);
const limiter = new TokenBucketLimiter(config);

const core = new ToolGatewayCore({
  config,
  upstreams,
  policy,
  broker,
  limiter,
  audit,
  killSwitch,
  logger,
});
const app = buildToolGatewayApp({ core, verifier, config, logger });

const port = envInt('ACP_TOOL_GATEWAY_PORT', 7106);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ port, servers: [...config.servers.keys()] }, 'tool gateway listening');

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
