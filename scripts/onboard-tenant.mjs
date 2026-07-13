/**
 * Onboards a tenant into the dev/CI platform (Phase 4 item 1): appends it to
 * the tenant registry (deploy/dev/tenants.json) and regenerates the NATS
 * accounts block. A LOCAL platform-admin operator tool — there is no
 * request-parameter-trusting onboarding route; tenancy is platform
 * configuration, changed by an operator with repo access and applied by a
 * container recreate.
 *
 *   node scripts/onboard-tenant.mjs <tenant> [--account TENANT_NAME]
 *
 * The account name defaults to TENANT_<TENANT> (uppercased, - → _). The
 * generator re-validates every isolation invariant (exact exports, bijection)
 * before anything is written, so a bad tenant id can never widen an account.
 */
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderAccountsConf } from './gen-nats-accounts.mjs';

const [tenant, ...rest] = process.argv.slice(2);
const accountIdx = rest.indexOf('--account');
const accountArg = accountIdx >= 0 ? rest[accountIdx + 1] : undefined;

if (tenant === undefined || tenant === '' || (accountIdx >= 0 && accountArg === undefined)) {
  console.error('usage: node scripts/onboard-tenant.mjs <tenant> [--account TENANT_NAME]');
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(repoRoot, 'deploy', 'dev', 'tenants.json');
const outPath = join(repoRoot, 'deploy', 'compose', 'nats', 'nats-accounts.gen.conf');

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
if (registry.some((t) => t.tenant === tenant)) {
  console.error(`tenant ${tenant} is already registered — nothing to do`);
  process.exit(1);
}
const account = accountArg ?? `TENANT_${tenant.toUpperCase().replaceAll('-', '_')}`;
const next = [...registry, { tenant, account }];

// Validate + render BEFORE writing the registry: a rejected entry must leave
// both files untouched.
const conf = renderAccountsConf(next);
writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
writeFileSync(outPath, conf, 'utf8');

console.log(`registered tenant ${tenant} → account ${account}`);
console.log(`updated ${registryPath}`);
console.log(`regenerated ${outPath}`);
console.log(
  '\nfollow-ups to make the tenant live:\n' +
    '  1. recreate the NATS container so the account exists:\n' +
    '       docker compose -f deploy/compose/docker-compose.yml -p acp-dev up -d\n' +
    "  2. add the tenant's token-service clients (users/agents) to\n" +
    '       deploy/dev/token-clients.json (tenant field = the new tenant id)\n' +
    "  3. set the tenant's budget cap in deploy/dev/tenant-budgets.json\n" +
    '       (absent = uncapped; the evaluation service applies caps at boot)\n' +
    '  4. restart the platform (scripts/run-platform.mjs re-derives\n' +
    '       ACP_BUS_TENANT_ACCOUNTS from the registry)',
);
