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
import { loadToolServerConfig } from './config.js';
import { ToolGatewayCore } from './core.js';
import { HttpPolicyClient } from './policy-client.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { UpstreamPool, type UpstreamBinding } from './upstream.js';

const logger = createLogger('tool-gateway');
const telemetry = initTelemetry('tool-gateway');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

const config = loadToolServerConfig(
  env('ACP_TOOL_SERVERS', join(repoRoot, 'deploy', 'dev', 'tool-servers.json')),
);

const tokenUrl = env('ACP_TOKEN_URL', 'http://localhost:7101');
const clientId = env('ACP_TOOL_GATEWAY_CLIENT_ID', 'svc-tool-gateway');
const clientSecret = env('ACP_TOOL_GATEWAY_CLIENT_SECRET', 'tool-gateway-dev-secret');

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
