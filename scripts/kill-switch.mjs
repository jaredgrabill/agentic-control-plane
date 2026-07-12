/**
 * Kill switch operator tooling.
 *
 * Tier 1 (agent) — via the Registry, which flips the fast-path control-KV
 * flag before announcing; every activation is an audit event
 * (killswitch.activated / killswitch.cleared):
 *
 *   node scripts/kill-switch.mjs suspend knowledge-agent --reason "bad citations"
 *   node scripts/kill-switch.mjs reinstate knowledge-agent --reason "drill complete"
 *
 * Principal denylist (ADR-0007 broker-time revocation, item 0c) — writes the
 * control-KV key the token service and NATS auth callout both watch, so a
 * revoked principal (a specific agent version, user, or service) gets no
 * fresh token and no new bus session within seconds:
 *
 *   node scripts/kill-switch.mjs deny-principal agent:cloud-agent@0.1.0 --reason "compromised"
 *   node scripts/kill-switch.mjs allow-principal agent:cloud-agent@0.1.0 --reason "cleared"
 *
 * The denylist has no Registry endpoint, so this path talks to NATS directly
 * (a platform bypass user in dev) and emits its own killswitch audit event.
 */
import console from 'node:console';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, target, ...rest] = process.argv.slice(2);
const reasonIdx = rest.indexOf('--reason');
const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;
const tenantIdx = rest.indexOf('--tenant');
const tenant = tenantIdx >= 0 ? rest[tenantIdx + 1] : 'acme';

const REGISTRY_ACTIONS = ['suspend', 'reinstate'];
const DENYLIST_ACTIONS = ['deny-principal', 'allow-principal'];

if (
  ![...REGISTRY_ACTIONS, ...DENYLIST_ACTIONS].includes(action ?? '') ||
  target === undefined ||
  reason === undefined
) {
  console.error(
    'usage:\n' +
      '  node scripts/kill-switch.mjs <suspend|reinstate> <agent-id> --reason "<why>"\n' +
      '  node scripts/kill-switch.mjs <deny-principal|allow-principal> <principal> --reason "<why>" [--tenant <t>]\n' +
      'The reason is mandatory: it lands in the audit record and the control state.',
  );
  process.exit(2);
}

if (DENYLIST_ACTIONS.includes(action)) {
  await runDenylist(action, target, reason, tenant);
} else {
  await runRegistry(action, target, reason);
}

async function runRegistry(action, agentId, reason) {
  const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
  const registryUrl = process.env.ACP_REGISTRY_URL ?? 'http://localhost:7102';
  const clientId = process.env.ACP_ADMIN_CLIENT_ID ?? 'svc-ci';
  const clientSecret = process.env.ACP_ADMIN_CLIENT_SECRET ?? 'ci-dev-secret';

  const tokenRes = await fetch(`${tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'acp:registry',
      scope: 'registry:admin',
    }),
  });
  if (!tokenRes.ok) {
    console.error(
      `token service refused admin credentials: ${tokenRes.status} ${await tokenRes.text()}`,
    );
    process.exit(1);
  }
  const { access_token } = await tokenRes.json();

  const started = Date.now();
  const res = await fetch(`${registryUrl}/v1/agents/${agentId}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ state: action === 'suspend' ? 'suspended' : 'active', reason }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`registry refused the transition: ${res.status} ${body}`);
    process.exit(1);
  }
  console.log(
    `${action} ${agentId} propagated in ${Date.now() - started}ms (SLO < 10s): ${JSON.parse(body).lifecycle_state}`,
  );
  if (action === 'suspend') {
    // Suspension stops NEW dispatch, but does not signal running Temporal
    // workflows. In-flight tasks auto-unwind at their next dispatch (discovery
    // fails); to stop one NOW, cancel it explicitly (agent-lifecycle.md runbook).
    console.log(
      '\nreminder: in-flight tasks are NOT interrupted by suspension alone.\n' +
        '  - they auto-unwind at their next step (discovery of the suspended agent fails), OR\n' +
        `  - force a drain-then-unwind now: POST ${gatewayUrl()}/v1/tasks/<task_id>/cancel\n` +
        '  - a compensation whose ONLY server is the suspended agent stays incomplete —\n' +
        '    compensate manually (see docs/architecture/agent-lifecycle.md kill-switch runbook).',
    );
  }
}

/** The gateway base URL used in the post-suspend reminder. */
function gatewayUrl() {
  return process.env.ACP_GATEWAY_URL ?? 'http://localhost:7100';
}

async function runDenylist(action, principal, reason, tenant) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Import the built service-kit by path: a bare script cannot resolve the
  // workspace package, but its dist resolves `nats` from its own node_modules.
  const { connectBus, KillSwitchControl, AuditPublisher, ensureAuditStream, createLogger } =
    await import(
      new URL(`file://${join(repoRoot, 'packages', 'service-kit', 'dist', 'index.js')}`).href
    );

  const logger = createLogger('kill-switch-cli');
  const nc = await connectBus({
    name: 'kill-switch-cli',
    user: process.env.ACP_ADMIN_NATS_USER ?? 'token',
    password: process.env.ACP_ADMIN_NATS_PASSWORD ?? 'token-dev-password',
  });
  try {
    const control = await KillSwitchControl.open(nc);
    const activatedBy = process.env.ACP_ADMIN_PRINCIPAL ?? 'svc:agent-ci';
    const started = Date.now();
    if (action === 'deny-principal') {
      await control.denyPrincipal(principal, reason, activatedBy);
    } else {
      await control.allowPrincipal(principal);
    }

    // Every activation is audited (governance-and-policy.md). The enforcement
    // record is token.denied at mint time; this is the activation record.
    await ensureAuditStream(nc);
    const audit = new AuditPublisher(nc, logger);
    await audit.publish({
      event_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      tenant,
      event_type: action === 'deny-principal' ? 'killswitch.activated' : 'killswitch.cleared',
      actor: { principal: activatedBy, delegation_chain: [{ sub: activatedBy }] },
      action: { name: action === 'deny-principal' ? 'killswitch.activated' : 'killswitch.cleared' },
      details: { tier: 'principal', target: principal, reason },
    });
    console.log(
      `${action} ${principal} written to control KV in ${Date.now() - started}ms (SLO < 10s)`,
    );
  } finally {
    await nc.drain();
  }
}
