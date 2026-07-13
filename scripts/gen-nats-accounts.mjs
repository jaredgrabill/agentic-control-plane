/**
 * Generates the NATS accounts block (deploy/compose/nats/nats-accounts.gen.conf)
 * from the tenant registry (deploy/dev/tenants.json) — Phase 4 item 1.
 *
 * In server-config mode a NATS account IS configuration: accounts are the
 * tenant isolation boundary, so the single source of truth is the registry
 * and everything derived from it (the accounts block, ACP_BUS_TENANT_ACCOUNTS,
 * token-clients) must stay in lockstep. This generator renders the accounts
 * block; run-platform.mjs derives ACP_BUS_TENANT_ACCOUNTS from the same file.
 *
 *   node scripts/gen-nats-accounts.mjs
 *
 * The generated conf is COMMITTED (CI's compose stack gets every tenant
 * without a generation step). Conf change ⇒ recreate the container:
 * `docker compose -p acp-dev up -d`.
 *
 * SECURITY INVARIANTS (the validator fails the generator on violation):
 *   - every tenant export is EXACTLY `acp.<tenant>.>` — never widened by a
 *     wildcard, never another tenant's prefix, never `acp.platform.>`;
 *   - every PLATFORM import of tenant traffic is per-tenant EXACT and bound
 *     to that tenant's account — no `acp.*.>` catch-all;
 *   - tenant → account is a bijection: no shared or duplicated account, no
 *     duplicated tenant, and no tenant may claim SYS/PLATFORM;
 *   - tenant ids are `[a-z0-9-]+` (the subject-builder / kill-switch-key
 *     alphabet) and account names are `[A-Z][A-Z0-9_]*`.
 *
 * The GA path for untrusted-operator deployments is nsc / decentralized
 * account JWTs (documented in docs/architecture/multi-tenancy.md, not built
 * here) — dev/CI keep static server config plus the auth callout.
 */
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TENANT_ID_RE = /^[a-z0-9-]+$/;
const ACCOUNT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_ACCOUNTS = new Set(['SYS', 'PLATFORM']);

/** The static platform users (fixed infra); tenants NEVER get static users. */
const PLATFORM_USERS = [
  'gateway',
  'orchestrator',
  'registry',
  'policy',
  'audit',
  'knowledge',
  'token',
  'tool-gateway',
  'llm-gateway',
  'evaluation',
];

/**
 * Validates the tenant registry against the security invariants above.
 * Throws (never warns) — a violated invariant must fail the generation, not
 * ship a widened account block.
 */
export function validateRegistry(registry) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('tenants.json must be a non-empty array of {tenant, account}');
  }
  const tenants = new Set();
  const accounts = new Set();
  for (const entry of registry) {
    const { tenant, account } = entry ?? {};
    if (typeof tenant !== 'string' || !TENANT_ID_RE.test(tenant)) {
      throw new Error(
        `tenant id ${JSON.stringify(tenant)} is not valid — expected /^[a-z0-9-]+$/ ` +
          '(a wildcard or dotted "tenant" would widen its subject export)',
      );
    }
    if (typeof account !== 'string' || !ACCOUNT_NAME_RE.test(account)) {
      throw new Error(
        `account name ${JSON.stringify(account)} for tenant ${tenant} is not valid — ` +
          'expected /^[A-Z][A-Z0-9_]*$/',
      );
    }
    if (RESERVED_ACCOUNTS.has(account)) {
      throw new Error(
        `tenant ${tenant} may not claim reserved account ${account} — tenants never ` +
          'share the platform or system account',
      );
    }
    if (tenants.has(tenant)) {
      throw new Error(`duplicate tenant ${tenant} — tenant → account must be a bijection`);
    }
    if (accounts.has(account)) {
      throw new Error(
        `account ${account} is claimed by more than one tenant — a shared account ` +
          'would collapse the isolation boundary',
      );
    }
    tenants.add(tenant);
    accounts.add(account);
  }
}

/**
 * Post-render defence: every export/import subject the block grants a tenant
 * must be exactly its own `acp.<tenant>.>`. Catches a future template edit
 * that widens a subject even if the registry itself validated.
 */
function validateRendered(registry, conf) {
  for (const { tenant } of registry) {
    const exact = `acp.${tenant}.>`;
    const lines = conf.split('\n').filter((l) => l.includes(`"acp.${tenant}.`));
    for (const line of lines) {
      const subjects = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      for (const subject of subjects) {
        if (subject !== exact) {
          throw new Error(
            `rendered subject ${subject} for tenant ${tenant} is not the exact ${exact}`,
          );
        }
      }
    }
  }
  const widened = conf.match(/"acp\.(\*|>)[^"]*"|"acp\.[^"]*\*[^"]*"/);
  if (widened !== null) {
    throw new Error(`rendered accounts block contains a widened tenant subject: ${widened[0]}`);
  }
  // Tenant exports render single-line; any platform subject on one of those
  // lines would grant a tenant a platform-internal surface.
  for (const line of renderTenantsOnly(conf).split('\n')) {
    if (line.trimStart().startsWith('exports:') && line.includes('acp.platform.')) {
      throw new Error('a tenant account exports a platform subject — refusing to render');
    }
  }
}

/** The tenant account blocks only (everything after the PLATFORM block). */
function renderTenantsOnly(conf) {
  const idx = conf.indexOf('# --- tenant accounts');
  return idx === -1 ? conf : conf.slice(idx);
}

/** Renders the whole accounts{} block for nats-accounts.gen.conf. */
export function renderAccountsConf(registry) {
  validateRegistry(registry);

  const platformUsers = PLATFORM_USERS.map(
    (u) =>
      `      { user: ${u}, password: $ACP_NATS_${u.toUpperCase().replaceAll('-', '_')}_PASSWORD }`,
  ).join(',\n');

  // PLATFORM imports each tenant's traffic per-tenant EXACT and account-bound:
  // a compromised TENANT_A cannot inject into acp.B.> because only B's account
  // may export acp.B.> and only that exact subject is imported from it.
  const platformImports = registry
    .map(
      ({ tenant, account }) =>
        `      { stream: { account: ${account}, subject: "acp.${tenant}.>" } }`,
    )
    .join(',\n');

  const tenantBlocks = registry
    .map(({ tenant, account }) =>
      [
        `  ${account}: {`,
        '    # No static users: tenant agents get session identities from the auth',
        '    # callout (aud of the minted user JWT places them in this account). The',
        '    # callout applies the exact publish/subscribe template parameterized per',
        '    # agent — see apps/token/src/bus-auth/core.ts.',
        `    exports: [{ stream: "acp.${tenant}.>" }]`,
        '    imports: [',
        '      { service: { account: PLATFORM, subject: "acp.platform.svc.>" } },',
        '      { stream: { account: PLATFORM, subject: "acp.platform.registry.>" } },',
        '      { stream: { account: PLATFORM, subject: "acp.platform.control.>" } }',
        '    ]',
        '  }',
      ].join('\n'),
    )
    .join('\n\n');

  const conf = `# GENERATED from deploy/dev/tenants.json — DO NOT EDIT BY HAND.
# Regenerate with: node scripts/gen-nats-accounts.mjs
# Conf change => recreate the container: docker compose -p acp-dev up -d
#
# Accounts are the tenant isolation boundary: each tenant account exports
# EXACTLY its own acp.<tenant>.> and imports only the three read-side platform
# surfaces; PLATFORM imports each tenant's traffic per-tenant exact. The
# generator validates these invariants and fails on any widening.

accounts {
  SYS: {
    users: [{ user: sys, password: $ACP_NATS_SYS_PASSWORD }]
  }

  PLATFORM: {
    jetstream: enabled
    users: [
${platformUsers}
    ]
    exports: [
      # Control-plane RPC surface consumed by tenant-side workers (e.g. the
      # SDK Retriever). Fine-grained authorization happens in the service
      # against the delegated JWT — bus permissions stay coarse.
      { service: "acp.platform.svc.>" },
      # Registry announcements and control flags (kill switch): read-only
      # fan-out to every tenant.
      { stream: "acp.platform.registry.>" },
      { stream: "acp.platform.control.>" }
    ]
    imports: [
      # Tenant events (audit, task, telemetry) flow into the platform
      # account, where the JetStream audit/task streams capture them.
${platformImports}
    ]
  }

  # --- tenant accounts (one per registry entry; session identities only) ---
${tenantBlocks}
}
`;

  validateRendered(registry, conf);
  return conf;
}

/** CLI entry: read the registry, render, write the committed gen conf. */
export function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const registryPath = join(repoRoot, 'deploy', 'dev', 'tenants.json');
  const outPath = join(repoRoot, 'deploy', 'compose', 'nats', 'nats-accounts.gen.conf');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const conf = renderAccountsConf(registry);
  writeFileSync(outPath, conf, 'utf8');
  console.log(
    `wrote ${outPath} (${registry.length} tenant account(s): ` +
      `${registry.map((t) => t.tenant).join(', ')})`,
  );
  console.log('reminder: recreate the NATS container to apply — docker compose -p acp-dev up -d');
}

// Run only when invoked directly (the E2E suite imports the module to unit-
// test the validator without writing the committed conf).
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
