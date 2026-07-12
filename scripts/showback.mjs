/**
 * Showback v0: an audit-derived cost report for one tenant. Reads the durable
 * task.completed audit stream (the authoritative cost record — StepResult/
 * TaskResult carry no cost fields in v0) and rolls it up into a plain table:
 * total cost, task count, cost per task, per-capability breakdown, and how
 * many tasks were fallback-priced. No dashboards, no OTel — just the numbers.
 *
 *   node scripts/showback.mjs <tenant> [--since <ISO-8601>]
 *
 * Precedent: kill-switch.mjs (env + client_credentials). The token is minted
 * for the audit audience (aud acp:audit, scope audit:read); the audit service
 * enforces both.
 */
import console from 'node:console';
import process from 'node:process';

const [tenant, ...rest] = process.argv.slice(2);
const sinceIdx = rest.indexOf('--since');
const since = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;

if (tenant === undefined || tenant === '' || (sinceIdx >= 0 && since === undefined)) {
  console.error(
    'usage: node scripts/showback.mjs <tenant> [--since <ISO-8601>]\n' +
      'Aggregates task.completed cost_usd from the audit stream for one tenant.',
  );
  process.exit(2);
}

const tokenUrl = process.env.ACP_TOKEN_URL ?? 'http://localhost:7101';
const auditUrl = process.env.ACP_AUDIT_URL ?? 'http://localhost:7104';
const clientId = process.env.ACP_ADMIN_CLIENT_ID ?? 'svc-ci';
const clientSecret = process.env.ACP_ADMIN_CLIENT_SECRET ?? 'ci-dev-secret';

const tokenRes = await fetch(`${tokenUrl}/v1/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience: 'acp:audit',
    scope: 'audit:read',
  }),
});
if (!tokenRes.ok) {
  console.error(
    `token service refused audit credentials: ${tokenRes.status} ${await tokenRes.text()}`,
  );
  process.exit(1);
}
const { access_token } = await tokenRes.json();

// v0: the audit query caps at 1000 rows (no cursor). Good enough for a
// dev/report tool; a paged rollup is a later cost-management item.
const query = new URLSearchParams({ tenant, event_type: 'task.completed', limit: '1000' });
const eventsRes = await fetch(`${auditUrl}/v1/events?${query.toString()}`, {
  headers: { authorization: `Bearer ${access_token}` },
});
if (!eventsRes.ok) {
  console.error(`audit query failed: ${eventsRes.status} ${await eventsRes.text()}`);
  process.exit(1);
}
const { events } = await eventsRes.json();

const sinceMs = since === undefined ? undefined : Date.parse(since);
if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
  console.error(`--since is not a valid ISO-8601 timestamp: ${since}`);
  process.exit(2);
}

let totalMicros = 0;
let tasks = 0;
let priced = 0;
let unpriced = 0;
let fallbackTasks = 0;
const perCapability = new Map(); // capability -> micros

const toMicros = (usd) => Math.round((usd ?? 0) * 1_000_000);

for (const event of events) {
  if (sinceMs !== undefined && Date.parse(event.occurred_at) < sinceMs) continue;
  const details = event.details ?? {};
  tasks += 1;
  const cost = details.usage_totals?.cost_usd;
  if (cost === null || cost === undefined) {
    unpriced += 1;
    continue;
  }
  priced += 1;
  totalMicros += toMicros(cost);
  if (details.cost_fallback_priced === true) fallbackTasks += 1;
  for (const step of details.steps ?? []) {
    if (step.cost_usd === undefined) continue;
    perCapability.set(
      step.capability,
      (perCapability.get(step.capability) ?? 0) + toMicros(step.cost_usd),
    );
  }
}

const usd = (micros) => `$${(micros / 1_000_000).toFixed(6)}`;

console.log(`Showback — tenant ${tenant}${since !== undefined ? ` since ${since}` : ''}`);
console.log('-'.repeat(52));
console.log(`tasks (completed):     ${tasks}`);
console.log(`  priced:              ${priced}`);
console.log(`  unpriced (no book):  ${unpriced}`);
console.log(`fallback-priced tasks: ${fallbackTasks}`);
console.log(`total cost:            ${usd(totalMicros)}`);
console.log(
  `cost / priced task:    ${priced > 0 ? usd(Math.round(totalMicros / priced)) : '$0.000000'}`,
);

if (perCapability.size > 0) {
  console.log('\nper capability:');
  const rows = [...perCapability.entries()].sort((a, b) => b[1] - a[1]);
  for (const [capability, micros] of rows) {
    console.log(`  ${capability.padEnd(32)} ${usd(micros)}`);
  }
}
