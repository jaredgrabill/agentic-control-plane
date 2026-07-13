/**
 * Runs the full control plane + the knowledge agent worker against the dev
 * stack (make dev). Used by `make platform` and the E2E suite. Requires a
 * prior `pnpm build` (services run from dist/) and `uv sync` (agent worker).
 *
 * Everything here is dev-profile wiring: dev credentials come from
 * deploy/dev/token-clients.json and the compose defaults; real deployments
 * inject their own.
 */
import { spawn } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokenClients = readFileSync(join(repoRoot, 'deploy', 'dev', 'token-clients.json'), 'utf8');

// Phase 4 item 1: the tenant registry is the single source of truth for the
// tenant → NATS account map. The NATS accounts block is generated from the
// same file (scripts/gen-nats-accounts.mjs), so callout minting and the
// server's account boundary can never drift apart.
const tenants = JSON.parse(readFileSync(join(repoRoot, 'deploy', 'dev', 'tenants.json'), 'utf8'));
const tenantAccounts = JSON.stringify(
  Object.fromEntries(tenants.map(({ tenant, account }) => [tenant, account])),
);

const base = {
  ...process.env,
  ACP_TOKEN_CLIENTS: tokenClients,
  ACP_TOKEN_ISSUER: 'https://token.acp.local',
  ACP_JWKS_URL: 'http://localhost:7101/.well-known/jwks.json',
  ACP_TOKEN_URL: 'http://localhost:7101',
  ACP_REGISTRY_URL: 'http://localhost:7102',
  ACP_POLICY_URL: 'http://localhost:7103',
  ACP_DATABASE_URL: 'postgres://acp:acp-dev-password@localhost:5432/acp',
  ACP_GATEWAY_URL: 'http://localhost:7100',
  ACP_EVALUATION_URL: 'http://localhost:7108',
  ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
  // Item 6: the online-eval config drives judge sampling, probes, budgets, drift.
  ACP_ONLINE_EVAL: join(repoRoot, 'deploy', 'dev', 'online-eval.json'),
  // Flush spans quickly so traces are queryable moments after a task runs.
  OTEL_BSP_SCHEDULE_DELAY: '500',
  // tenant claim → NATS account NAME, derived from deploy/dev/tenants.json.
  ACP_BUS_TENANT_ACCOUNTS: tenantAccounts,
};

const services = [
  [
    'token',
    'node',
    ['apps/token/dist/main.js'],
    {
      // NATS auth callout: dev seeds for the issuer account (signs minted
      // bus user JWTs) and the responder xkey (seals auth requests). Their
      // public halves are in deploy/compose/nats/nats-server.conf. Committed
      // dev-only — a hardened deployment vaults fresh seeds.
      ACP_NATS_AUTH_ISSUER_SEED: 'SAAJEKZZJVRSXKW4IF7JU553MIIBJ33TBQTEREDBX6PUDOYXCQ4LFBBV24',
      ACP_NATS_AUTH_XKEY_SEED: 'SXAK5Q7G7ZME7KLXT6BL6IGR7LCKOOBUSNTZCYEACXZP2WIWSWPARSQYKY',
    },
  ],
  ['audit', 'node', ['apps/audit/dist/main.js'], {}],
  [
    'registry',
    'node',
    ['apps/registry/dist/main.js'],
    {
      // Item 3 (a2a edge): platform-controlled card export allowlist.
      ACP_A2A_EXPOSURE: join(repoRoot, 'deploy', 'dev', 'a2a-exposure.json'),
      // Item 3 (SF3): backward-compat seed for the tool-server catalog. The
      // catalog is consumed only when a tool gateway sets ACP_TOOL_CATALOG_URL
      // (default OFF), so seeding leaves dev/CI behavior unchanged.
      ACP_TOOL_CATALOG_SEED: join(repoRoot, 'deploy', 'dev', 'tool-servers.json'),
    },
  ],
  ['policy', 'node', ['apps/policy/dist/main.js'], {}],
  ['knowledge', 'node', ['apps/knowledge/dist/main.js'], {}],
  [
    'tool-gateway',
    'node',
    ['apps/tool-gateway/dist/main.js'],
    {
      ACP_TOOL_GATEWAY_CLIENT_ID: 'svc-tool-gateway',
      ACP_TOOL_GATEWAY_CLIENT_SECRET: 'tool-gateway-dev-secret',
      ACP_NATS_SERVICE_USER: 'tool-gateway',
      ACP_NATS_SERVICE_PASSWORD: 'tool-gateway-dev-password',
      ACP_TOOL_SERVERS: join(repoRoot, 'deploy', 'dev', 'tool-servers.json'),
    },
  ],
  [
    'llm-gateway',
    'node',
    ['apps/llm-gateway/dist/main.js'],
    {
      ACP_LLM_GATEWAY_CLIENT_ID: 'svc-llm-gateway',
      ACP_LLM_GATEWAY_CLIENT_SECRET: 'llm-gateway-dev-secret',
      ACP_NATS_SERVICE_USER: 'llm-gateway',
      ACP_NATS_SERVICE_PASSWORD: 'llm-gateway-dev-password',
      ACP_MODEL_CLASSES: join(repoRoot, 'deploy', 'dev', 'model-classes.json'),
    },
  ],
  [
    'gateway',
    'node',
    ['apps/gateway/dist/main.js'],
    {
      // Item 3 (a2a edge): the gateway's own service identity for reading
      // signed a2a cards from the registry. The public /.well-known routes
      // stay 404 without these.
      ACP_GATEWAY_CLIENT_ID: 'svc-gateway',
      ACP_GATEWAY_CLIENT_SECRET: 'gateway-dev-secret',
    },
  ],
  // Item 6: the online-eval scores service (port 7108) — scores store +
  // enforcement brain (budget/drift/ladder). Boots after the stack is up.
  [
    'evaluation',
    'node',
    ['apps/evaluation/dist/main.js', 'serve'],
    {
      ACP_EVALUATION_CLIENT_ID: 'svc-evaluation',
      ACP_EVALUATION_CLIENT_SECRET: 'evaluation-dev-secret',
      ACP_NATS_SERVICE_USER: 'evaluation',
      ACP_NATS_SERVICE_PASSWORD: 'evaluation-dev-password',
      // Phase 4 item 1: per-tenant budget caps (platform config, never a
      // request field). Applied for the current period at boot.
      ACP_TENANT_BUDGETS: join(repoRoot, 'deploy', 'dev', 'tenant-budgets.json'),
    },
  ],
  [
    'orchestrator',
    'node',
    ['apps/orchestrator/dist/main.js'],
    {
      ACP_ORCHESTRATOR_CLIENT_ID: 'svc-orchestrator',
      ACP_ORCHESTRATOR_CLIENT_SECRET: 'orchestrator-dev-secret',
      // Item 6: the judge scores online; the prober mints its own subject token.
      ACP_PROBER_CLIENT_ID: 'svc-prober',
      ACP_PROBER_CLIENT_SECRET: 'prober-dev-secret',
    },
  ],
  [
    'knowledge-agent',
    'uv',
    ['run', '--directory', 'python', 'python', '-m', 'knowledge_agent.main'],
    {
      // Item 0c: the agent mints an acp:bus token with its own client and
      // connects through the auth callout — no static NATS user/password.
      ACP_AGENT_CLIENT_ID: 'agent-knowledge-agent',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-knowledge-dev-secret',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
    },
  ],
  // Phase 4 item 1: a SECOND-tenant worker for the same agent binary. Its own
  // token-service client carries tenant globex, so its callout-minted bus
  // session lands in TENANT_GLOBEX — the E2E isolation proof exercises this
  // identity. It polls the same agent-{id}@{version} Temporal queue.
  [
    'knowledge-agent-globex',
    'uv',
    ['run', '--directory', 'python', 'python', '-m', 'knowledge_agent.main'],
    {
      ACP_AGENT_CLIENT_ID: 'agent-knowledge-agent-globex',
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-knowledge-globex-dev-secret',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
    },
  ],
  // Mock MCP tool servers (dev/CI stand-ins for enterprise systems) and the
  // TS tool agents. The agents use noRetriever, so they need no NATS creds
  // and no token-service client entries.
  [
    'cloud-mock',
    'node',
    ['deploy/mocks/dist/cloud/main.js'],
    { ACP_MOCK_CLOUD_PORT: '7301', ACP_MOCK_FIXTURES: join(repoRoot, 'fixtures', 'acme-corp') },
  ],
  [
    'forge-mock',
    'node',
    ['deploy/mocks/dist/forge/main.js'],
    { ACP_MOCK_FORGE_PORT: '7302', ACP_MOCK_FIXTURES: join(repoRoot, 'fixtures', 'acme-corp') },
  ],
  [
    'itsm-mock',
    'node',
    ['deploy/mocks/dist/itsm/main.js'],
    { ACP_MOCK_ITSM_PORT: '7303', ACP_MOCK_FIXTURES: join(repoRoot, 'fixtures', 'acme-corp') },
  ],
  [
    'netsec-mock',
    'node',
    ['deploy/mocks/dist/netsec/main.js'],
    { ACP_MOCK_NETSEC_PORT: '7304', ACP_MOCK_FIXTURES: join(repoRoot, 'fixtures', 'acme-corp') },
  ],
  // Item 3 (a2a proxy): a mock third-party A2A JSON-RPC remote. The external-echo
  // proxy agent reaches it with its OWN credential (ACP_PROXY_CREDENTIAL); the
  // mock rejects any other bearer, so the E2E proves the platform's delegated
  // token never egresses to it.
  [
    'a2a-mock',
    'node',
    ['deploy/mocks/dist/a2a/main.js'],
    {
      ACP_MOCK_A2A_PORT: '7305',
      ACP_MOCK_A2A_CREDENTIAL: 'external-echo-remote-dev-credential',
    },
  ],
  // Item 5: agent tool calls traverse the Tool Gateway PEP; the mocks stay
  // reachable on 7301/7302 as the gateway's upstreams only. Item 0c: each
  // agent holds its OWN token-service client so it can exchange the step's
  // delegated token for the gateway's acp:tools audience (a second,
  // independent credential — a stolen step token opens nothing).
  [
    'cloud-agent',
    'node',
    ['agents/cloud/dist/main.js'],
    {
      ACP_TOOL_SERVER_CLOUD_ESTATE_URL: 'http://localhost:7106/mcp/cloud-estate',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
      ACP_AGENT_CLIENT_ID: 'agent-cloud-agent',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-cloud-dev-secret',
    },
  ],
  [
    'code-agent',
    'node',
    ['agents/code/dist/main.js'],
    {
      ACP_TOOL_SERVER_CODE_FORGE_URL: 'http://localhost:7106/mcp/code-forge',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
      ACP_AGENT_CLIENT_ID: 'agent-code-agent',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-code-dev-secret',
    },
  ],
  [
    'change-agent',
    'node',
    ['agents/change/dist/main.js'],
    {
      ACP_TOOL_SERVER_ITSM_URL: 'http://localhost:7106/mcp/itsm',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
      ACP_AGENT_CLIENT_ID: 'agent-change-agent',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-change-dev-secret',
    },
  ],
  [
    'netsec-agent',
    'node',
    ['agents/netsec/dist/main.js'],
    {
      ACP_TOOL_SERVER_NETSEC_URL: 'http://localhost:7106/mcp/netsec',
      ACP_LLM_GATEWAY_URL: 'http://localhost:7107',
      ACP_AGENT_CLIENT_ID: 'agent-netsec-agent',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
      ACP_AGENT_CLIENT_SECRET: 'agent-netsec-dev-secret',
    },
  ],
  // Item 3 (a2a proxy): the external-echo proxy agent. It uses noRetriever, so
  // the worker needs no NATS creds; it forwards its capability to the mock A2A
  // remote (7305) with its OWN ACP_PROXY_CREDENTIAL — never the delegated token.
  [
    'external-echo-agent',
    'node',
    ['agents/external-echo/dist/main.js'],
    {
      ACP_PROXY_ENDPOINT: 'http://localhost:7305/a2a',
      ACP_PROXY_CREDENTIAL: 'external-echo-remote-dev-credential',
      ACP_AGENT_CLIENT_ID: 'agent-external-echo',
      // Version-qualifies this worker's task queue (item 4).
      ACP_AGENT_VERSION: '0.1.0',
    },
  ],
];

// Pre-flight: a platform already running would produce EADDRINUSE chaos.
try {
  await fetch('http://localhost:7101/healthz');
  console.error('a platform is already listening on :7101 — stop it before starting another');
  process.exit(1);
} catch {
  // ports free — good
}

const children = [];
for (const [name, cmd, args, extraEnv] of services) {
  // No shell wrapper: node/uv are real executables, and killing a cmd.exe
  // wrapper on Windows would orphan the actual service process.
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...base, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => {
    console.error(`[${name}] exited with ${code}`);
    if (code !== 0 && !shuttingDown) {
      shutdown(1);
    }
  });
  children.push([name, child]);
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [, child] of children) {
    if (process.platform === 'win32') {
      // Kill the whole tree: uv wraps python, and TerminateProcess does
      // not cascade.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }
  setTimeout(() => process.exit(code), 2000);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Readiness gate: every HTTP door answers /healthz. The mocks (7301/7302)
// have one; the agents are Temporal workers with no HTTP door.
const healthPorts = [
  7101, 7102, 7103, 7104, 7105, 7106, 7107, 7100, 7108, 7301, 7302, 7303, 7304, 7305,
];
const deadline = Date.now() + 120_000;
for (const port of healthPorts) {
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      console.error(`service on :${port} never became healthy`);
      shutdown(1);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
// Item 6: auto-start the singleton synthetic prober once the orchestrator
// worker can serve its workflows. Best-effort — a prober hiccup must not fail
// the platform (the workers may still be polling; a retry loop absorbs that).
async function startProber() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const child = spawn('node', ['scripts/probes.mjs', 'start'], {
      cwd: repoRoot,
      env: base,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => process.stderr.write(`[prober-start] ${d}`));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (code === 0) {
      process.stdout.write(`[prober-start] ${out}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('[prober-start] could not start the synthetic prober after retries (non-fatal)');
}
await startProber();

console.log('PLATFORM_READY (temporal workers may take a few more seconds to poll)');
