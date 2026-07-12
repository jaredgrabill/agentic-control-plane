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

const base = {
  ...process.env,
  ACP_TOKEN_CLIENTS: tokenClients,
  ACP_TOKEN_ISSUER: 'https://token.acp.local',
  ACP_JWKS_URL: 'http://localhost:7101/.well-known/jwks.json',
  ACP_TOKEN_URL: 'http://localhost:7101',
  ACP_REGISTRY_URL: 'http://localhost:7102',
  ACP_POLICY_URL: 'http://localhost:7103',
  ACP_DATABASE_URL: 'postgres://acp:acp-dev-password@localhost:5432/acp',
  // Flush spans quickly so traces are queryable moments after a task runs.
  OTEL_BSP_SCHEDULE_DELAY: '500',
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
  ['registry', 'node', ['apps/registry/dist/main.js'], {}],
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
  ['gateway', 'node', ['apps/gateway/dist/main.js'], {}],
  [
    'orchestrator',
    'node',
    ['apps/orchestrator/dist/main.js'],
    {
      ACP_ORCHESTRATOR_CLIENT_ID: 'svc-orchestrator',
      ACP_ORCHESTRATOR_CLIENT_SECRET: 'orchestrator-dev-secret',
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
      ACP_AGENT_CLIENT_SECRET: 'agent-knowledge-dev-secret',
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
      ACP_AGENT_CLIENT_SECRET: 'agent-code-dev-secret',
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
const healthPorts = [7101, 7102, 7103, 7104, 7105, 7106, 7107, 7100, 7301, 7302];
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
console.log('PLATFORM_READY (temporal workers may take a few more seconds to poll)');
