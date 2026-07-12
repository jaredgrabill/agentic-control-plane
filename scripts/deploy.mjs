/**
 * Deployment Controller operator tooling — starts, watches, and aborts a
 * DeploymentWorkflow through the gateway (never Temporal directly). The
 * controller does the rest: shadow soak, canary ramp with session pinning,
 * quality/latency/cost gates, auto-rollback, demotion, owner approval (R2+),
 * atomic promote, drain — with zero manual routing.
 *
 *   node scripts/deploy.mjs start <agent-id> <candidate-version> [--tenant acme] [--config '{...}']
 *   node scripts/deploy.mjs status <agent-id>
 *   node scripts/deploy.mjs abort <agent-id>
 *
 * Authenticates as a deploy client (svc-ci by default: scopes [deploy:write,
 * deploy:read]). The deployment is a per-agent singleton — a second concurrent
 * `start` is refused (409).
 */
import console from 'node:console';
import process from 'node:process';

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positionals = args.filter(
  (a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]?.startsWith('--')),
);

const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
const gatewayUrl = process.env.ACP_GATEWAY_URL ?? 'http://localhost:7100';
const clientId = process.env.ACP_DEPLOY_CLIENT_ID ?? 'svc-ci';
const clientSecret = process.env.ACP_DEPLOY_CLIENT_SECRET ?? 'ci-dev-secret';

async function mint(scope) {
  const res = await fetch(`${tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'acp:gateway',
      scope,
    }),
  });
  if (!res.ok) {
    console.error(`token service refused deploy credentials: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()).access_token;
}

async function start() {
  const [agentId, candidateVersion] = positionals;
  if (agentId === undefined || candidateVersion === undefined) {
    console.error(
      'usage: deploy.mjs start <agent-id> <candidate-version> [--tenant t] [--config json]',
    );
    process.exit(2);
  }
  const tenant = flag('--tenant');
  const rawConfig = flag('--config');
  let config;
  if (rawConfig !== undefined) {
    try {
      config = JSON.parse(rawConfig);
    } catch (err) {
      console.error(`--config is not valid JSON: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  }
  const token = await mint('deploy:write');
  const res = await fetch(`${gatewayUrl}/v1/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      agent_id: agentId,
      candidate_version: candidateVersion,
      ...(tenant === undefined ? {} : { tenant }),
      ...(config === undefined ? {} : { config }),
    }),
  });
  const body = await res.json();
  if (res.status === 409) {
    console.error(`a deployment for ${agentId} is already running — abort or await it`);
    process.exit(1);
  }
  if (res.status !== 202) {
    console.error(`deploy start failed: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`deployment started: ${body.deployment_id}`);
  console.log(`  agent:     ${body.agent_id}@${body.candidate_version}`);
  console.log(`  workflow:  ${body.workflow_run_id}`);
  console.log(`\nwatch it with:  node scripts/deploy.mjs status ${agentId}`);
}

async function status() {
  const [agentId] = positionals;
  if (agentId === undefined) {
    console.error('usage: deploy.mjs status <agent-id>');
    process.exit(2);
  }
  const token = await mint('deploy:read');
  const res = await fetch(`${gatewayUrl}/v1/deployments/${agentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    console.error(`no deployment for ${agentId}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`deploy status failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const view = await res.json();
  console.log('='.repeat(56));
  console.log(`Deployment ${view.deployment_id}`);
  console.log('='.repeat(56));
  console.log(
    `  phase:    ${view.phase}${view.ramp_percent !== undefined ? ` @ ${view.ramp_percent}%` : ''}`,
  );
  console.log(`  running:  ${view.running ?? false}   aborted: ${view.aborted}`);
  if (Array.isArray(view.gate_reports) && view.gate_reports.length > 0) {
    console.log('  gate reports:');
    for (const r of view.gate_reports) {
      console.log(
        `    - ${r.verdict}  (candidate ${r.samples?.candidate ?? '?'} / incumbent ${r.samples?.incumbent ?? '?'})` +
          (r.reasons?.length ? `  ${r.reasons.join('; ')}` : ''),
      );
    }
  }
  if (view.result !== undefined) {
    console.log(`  result:   ${view.result.status} — ${view.result.reason ?? ''}`);
  }
}

async function abort() {
  const [agentId] = positionals;
  if (agentId === undefined) {
    console.error('usage: deploy.mjs abort <agent-id>');
    process.exit(2);
  }
  const token = await mint('deploy:write');
  const res = await fetch(`${gatewayUrl}/v1/deployments/${agentId}/abort`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    console.error(`no running deployment for ${agentId}`);
    process.exit(1);
  }
  if (res.status === 409) {
    console.error(`the deployment for ${agentId} is already terminal`);
    process.exit(1);
  }
  if (res.status !== 202) {
    console.error(`deploy abort failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`aborting deployment for ${agentId} — it will demote to shadow`);
}

const commands = { start, status, abort };
const run = commands[command];
if (run === undefined) {
  console.error('usage: deploy.mjs <start|status|abort> ...');
  process.exit(2);
}
await run();
