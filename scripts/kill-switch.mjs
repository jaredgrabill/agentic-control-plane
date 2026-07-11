/**
 * Kill switch tier 1 (agent): suspend / reinstate one agent via the
 * Registry, which flips the fast-path control-KV flag before announcing.
 * Named owner + runbook live with the on-call docs; every activation is an
 * audit event (killswitch.activated / killswitch.cleared).
 *
 *   node scripts/kill-switch.mjs suspend knowledge-agent --reason "bad citations"
 *   node scripts/kill-switch.mjs reinstate knowledge-agent --reason "drill complete"
 */
import console from 'node:console';
import process from 'node:process';

const [action, agentId, ...rest] = process.argv.slice(2);
const reasonIdx = rest.indexOf('--reason');
const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;

if (
  !['suspend', 'reinstate'].includes(action ?? '') ||
  agentId === undefined ||
  reason === undefined
) {
  console.error(
    'usage: node scripts/kill-switch.mjs <suspend|reinstate> <agent-id> --reason "<why>"\n' +
      'The reason is mandatory: it lands in the audit record and the registry state.',
  );
  process.exit(2);
}

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
