/**
 * Paved-road SLO harness (item 3, SF4). Proves the two claims that make the
 * platform self-service:
 *
 *   1. SLO: an external team can scaffold an agent and take it from a bare
 *      manifest to a registered SHADOW version in well under the SLO — the
 *      whole path is API-driven (provision client → register → baseline →
 *      shadow), no operator in the loop. With { driveToActive: true } the same
 *      API-only path is driven all the way to ACTIVE via the registered→active
 *      admin edge (agent-lifecycle.md: there is no shadow→active edge, so the
 *      onboarding-to-active proof takes the direct admin promotion), and the
 *      zero-change invariant is re-asserted at active.
 *   2. ZERO PLATFORM CHANGES: onboarding touches NO platform-owned file —
 *      not apps/**, packages/**, deploy/** (incl. token-clients.json),
 *      .github/**, policies/**, or run-platform.mjs. The one seam that used to
 *      force a token-clients.json edit (a served agent needs a bus client
 *      credential) is now closed by POST /v1/clients: the client is provisioned
 *      dynamically, so the git working tree gains no platform diff.
 *
 * The scaffold lives in an OS temp dir (never the repo), so a real external
 * team's new agents/<name> directory is the ONLY thing that would ever show up
 * — and here nothing does. Runnable as a CLI (node scripts/paved-road-slo.mjs)
 * and importable by the E2E suite.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Platform-owned paths onboarding must never touch (the zero-change invariant). */
const PLATFORM_PREFIXES = [
  'apps/',
  'packages/',
  'deploy/',
  '.github/',
  'policies/',
  'scripts/run-platform.mjs',
];

async function mintToken(tokenUrl, clientId, clientSecret, audience, scope) {
  const res = await fetch(`${tokenUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, `token mint for ${clientId} failed (http ${res.status}): ${body}`);
  return JSON.parse(body).access_token;
}

/** Reads a response body ONCE, asserts an accepted status, and parses JSON. */
async function expectJson(res, okStatuses, label) {
  const body = await res.text();
  assert.ok(okStatuses.includes(res.status), `${label} failed (http ${res.status}): ${body}`);
  return body === '' ? {} : JSON.parse(body);
}

/** The set of git working-tree changes under platform-owned paths. */
function platformChanges(repoRoot) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return new Set(
    out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => {
        const path = line.slice(3).replace(/^"|"$/g, '');
        return PLATFORM_PREFIXES.some((p) => path.startsWith(p));
      }),
  );
}

/**
 * Scaffolds a minimal pure-LLM R0 agent into a throwaway temp dir (never the
 * repo). Returns both the on-disk manifest path and the parsed object form the
 * registration uses — kept in one place so they cannot drift.
 */
function scaffoldAgent(agentId) {
  const manifest = {
    id: agentId,
    name: 'Paved Road Probe Agent',
    owner: 'team-external',
    description:
      'A throwaway pure-LLM R0 agent scaffolded by the paved-road SLO harness to prove an external team can onboard with zero platform changes.',
    capabilities: [
      {
        name: 'probe.echo',
        description: 'Echoes a cited answer (R0, no side effects).',
        risk: 'R0',
        input_schema: { type: 'object' },
        output_schema: {
          type: 'object',
          required: ['text', 'citations', 'confidence'],
          properties: {
            text: { type: 'string' },
            citations: { type: 'array' },
            confidence: { type: 'number' },
          },
        },
        examples: [{ input: {} }, { input: {} }, { input: {} }],
      },
    ],
    models: { allowed: ['default-tier'] },
    data_classification: 'internal',
  };
  const dir = mkdtempSync(join(tmpdir(), 'acp-paved-'));
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, path, manifest };
}

/**
 * Runs the paved-road path end to end and asserts the SLO + zero-change
 * invariant. Returns a result summary; throws on any violation.
 */
export async function runPavedRoadSlo(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const tokenUrl = options.tokenUrl ?? 'http://localhost:7101';
  const registryUrl = options.registryUrl ?? 'http://localhost:7102';
  const sloMs = options.sloMs ?? 60_000;
  const log = options.log ?? (() => {});
  // Dev creds; a real run injects its own. The caller (a tenant-user) provisions;
  // the deployer (registry:deploy) drives the shadow transition.
  const caller = options.caller ?? { id: 'cli-jane', secret: 'jane-dev-secret' };
  // The registrar holds registry:write (agent registration + baseline); the
  // deployer holds registry:deploy (the registered→shadow edge).
  const registrar = options.registrar ?? { id: 'svc-ci', secret: 'ci-dev-secret' };
  const deployer = options.deployer ?? {
    id: 'svc-orchestrator',
    secret: 'orchestrator-dev-secret',
  };
  // The admin holds registry:admin (the registered→active promotion edge). Used
  // only when driveToActive is set; onboarding stays fully API-driven.
  const admin = options.admin ?? { id: 'svc-ci', secret: 'ci-dev-secret' };
  const driveToActive = options.driveToActive === true;

  const agentId = `paved-probe-${randomBytes(4).toString('hex')}`;
  const version = '0.1.0';
  const started = Date.now();

  // Snapshot platform diffs BEFORE onboarding so a pre-existing dirty tree
  // (e.g. an in-progress branch) cannot be mistaken for an onboarding change.
  const before = platformChanges(repoRoot);

  // 1. Scaffold (outside the repo).
  const scaffold = scaffoldAgent(agentId);
  const manifest = scaffold.manifest;
  log(`scaffolded ${agentId} in ${scaffold.dir}`);

  // 2. Self-service client provisioning — the step that closes the
  //    token-clients.json seam. No platform file is edited.
  const provisionRes = await fetch(`${tokenUrl}/v1/clients`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${caller.id}:${caller.secret}`).toString('base64')}`,
    },
    body: JSON.stringify({ principal: `agent:${agentId}@${version}` }),
  });
  const client = await expectJson(provisionRes, [201], 'provision');
  assert.deepEqual(client.roles, ['agent'], 'provisioned client must be agent-role');
  assert.deepEqual(client.scopes, [], 'provisioned client must carry zero scopes');
  assert.ok(client.client_secret, 'provisioned client must return its secret once');
  log(`provisioned client ${client.client_id} (agent role, zero scopes)`);

  // 3. Register the scaffolded manifest.
  const writeToken = await mintToken(
    tokenUrl,
    registrar.id,
    registrar.secret,
    'acp:registry',
    'registry:write',
  );
  const registerRes = await fetch(`${registryUrl}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify({ manifest, version }),
  });
  await expectJson(registerRes, [200, 201], 'register');
  log(`registered ${agentId}@${version}`);

  // 4. Record a baseline (shadow entry requires one).
  const baseline = {
    schema: 'acp-eval-baseline/v1',
    agent_id: agentId,
    agent_version: version,
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    suite: {
      digest: `sha256:${createHash('sha256').update(agentId).digest('hex')}`,
      case_count: 1,
    },
    harness: 'acp-paved-road-slo@0.1.0',
    recorded_at: new Date().toISOString(),
  };
  const baselineRes = await fetch(`${registryUrl}/v1/agents/${agentId}/baseline`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify(baseline),
  });
  await expectJson(baselineRes, [200], 'baseline');

  // 5. Terminal transition. Default: registered → shadow (a registry:deploy
  //    edge). driveToActive: registered → active directly (the registry:admin
  //    promotion edge — there is no shadow→active edge, so the onboarding-to-
  //    active proof takes the documented admin promotion).
  let lifecycleState;
  if (driveToActive) {
    const adminToken = await mintToken(
      tokenUrl,
      admin.id,
      admin.secret,
      'acp:registry',
      'registry:admin',
    );
    const activeRes = await fetch(`${registryUrl}/v1/agents/${agentId}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ state: 'active', reason: 'paved-road onboarding to active' }),
    });
    const activeCard = await expectJson(activeRes, [200], 'active transition');
    lifecycleState = activeCard.lifecycle_state;
    assert.equal(lifecycleState, 'active');
    log(`promoted ${agentId}@${version} to active (registered→active admin edge)`);
  } else {
    const deployToken = await mintToken(
      tokenUrl,
      deployer.id,
      deployer.secret,
      'acp:registry',
      'registry:deploy',
    );
    const shadowRes = await fetch(`${registryUrl}/v1/agents/${agentId}/versions/${version}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deployToken}` },
      body: JSON.stringify({ state: 'shadow', reason: 'paved-road slo probe' }),
    });
    const shadowCard = await expectJson(shadowRes, [200], 'shadow transition');
    lifecycleState = shadowCard.lifecycle_state;
    assert.equal(lifecycleState, 'shadow');
    log(`transitioned ${agentId}@${version} to shadow`);
  }

  const elapsedMs = Date.now() - started;

  // 6. SLO assertion.
  const target = driveToActive ? 'active' : 'shadow';
  assert.ok(
    elapsedMs < sloMs,
    `scaffold→${target} took ${elapsedMs}ms, over the SLO of ${sloMs}ms`,
  );

  // 7. Zero-platform-changes invariant: onboarding introduced NO new platform diff.
  const after = platformChanges(repoRoot);
  const introduced = [...after].filter((line) => !before.has(line));
  assert.deepEqual(
    introduced,
    [],
    `onboarding changed platform-owned files (must be zero):\n${introduced.join('\n')}`,
  );

  return {
    ok: true,
    agentId,
    version,
    clientId: client.client_id,
    lifecycleState,
    reachedActive: lifecycleState === 'active',
    elapsedMs,
    sloMs,
  };
}

// CLI entrypoint.
const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === entry) {
  runPavedRoadSlo({ log: (m) => console.log(`[paved-road] ${m}`) })
    .then((result) => {
      console.log(`[paved-road] PASS ${JSON.stringify(result)}`);
    })
    .catch((err) => {
      console.error(`[paved-road] FAIL ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
