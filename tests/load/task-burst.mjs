#!/usr/bin/env node
/**
 * Task-burst load / soak harness for the ACP gateway.
 *
 * Standalone Node ESM — NO build step, NOT part of the turbo graph, NOT wired
 * into PR CI. Run it by hand or from a nightly job against a running platform
 * (`make dev` + `make platform`). It submits tasks through the gateway's public
 * ingress exactly like the E2E exit scenario (POST /v1/tasks with a
 * client-credentials JWT), polls each to a terminal state, and reports latency
 * + success SLOs.
 *
 * Auth: mints a JWT from the token service (:7101) with the dev client
 * `cli-jane` / `jane-dev-secret` (audience acp:gateway), matching the E2E
 * support. Override with env: ACP_LOAD_CLIENT_ID / ACP_LOAD_CLIENT_SECRET /
 * ACP_LOAD_AUDIENCE, or supply a ready token via ACP_LOAD_TOKEN to skip minting.
 *
 * Modes:
 *   load  — hold a target submission rate for a duration, then assert SLOs
 *           (p95 latency, success rate) and exit non-zero on breach.
 *   soak  — hold a low rate for a long duration, checking for latency drift
 *           and backlog growth (no-leak signal). Exits non-zero on drift/breach.
 *
 * Examples:
 *   node tests/load/task-burst.mjs load --rps 5 --duration 60
 *   node tests/load/task-burst.mjs load --rps 10 --duration 120 --p95 30000 --success 0.99
 *   node tests/load/task-burst.mjs soak --rps 1 --duration 3600
 */
import process from 'node:process';

const TOKEN_URL = process.env.ACP_LOAD_TOKEN_URL ?? 'http://localhost:7101';
const GATEWAY_URL = process.env.ACP_LOAD_GATEWAY_URL ?? 'http://localhost:7100';
const CLIENT_ID = process.env.ACP_LOAD_CLIENT_ID ?? 'cli-jane';
const CLIENT_SECRET = process.env.ACP_LOAD_CLIENT_SECRET ?? 'jane-dev-secret';
const AUDIENCE = process.env.ACP_LOAD_AUDIENCE ?? 'acp:gateway';
const QUESTION = process.env.ACP_LOAD_QUESTION ?? 'What does our policy say about change freezes?';

function parseArgs(argv) {
  const mode = argv[0];
  const opts = {
    rps: 5,
    duration: 60, // seconds
    p95: 30_000, // ms — SLO 2a default (30s)
    success: 0.99, // dispatch/task success floor
    timeout: 60_000, // per-task poll timeout ms
    // soak-only: allowed p95 drift between first and last quartile (ratio).
    drift: 1.5,
  };
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const val = argv[i + 1];
    if (key === undefined || val === undefined) continue;
    if (!(key in opts)) continue;
    const num = Number(val);
    // A typo (`--rps five`) must fail loudly, not silently coerce to NaN and
    // then drive zero traffic or an infinite loop downstream.
    if (Number.isNaN(num)) {
      process.stderr.write(`invalid numeric value for --${key}: ${JSON.stringify(val)}\n`);
      process.exit(2);
    }
    opts[key] = num;
  }
  return { mode, opts };
}

async function mintToken() {
  const res = await fetch(`${TOKEN_URL}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: AUDIENCE,
    }),
  });
  if (!res.ok) {
    throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

/**
 * Caches an access token and re-mints on demand. Client-credentials tokens are
 * TTL-capped (ADR-0004: 15 min), so a `soak --duration 3600` run WILL outlive
 * its token; without re-minting every request 401s past the TTL and the harness
 * reports a false SLO breach. A pre-supplied ACP_LOAD_TOKEN is static — used
 * as-is and never re-minted (re-mint would hand back the same expired token).
 */
function makeTokenProvider() {
  const staticToken = process.env.ACP_LOAD_TOKEN;
  let cached = staticToken ?? null;
  let inflight = null;
  return {
    async get() {
      if (cached !== null) return cached;
      if (inflight === null) {
        inflight = mintToken().then((t) => {
          cached = t;
          inflight = null;
          return t;
        });
      }
      return inflight;
    },
    /** Drop the given token so the next get() re-mints (no-op for a static token). */
    invalidate(token) {
      if (staticToken === undefined && cached === token) cached = null;
    },
  };
}

/** fetch with the current token; on a 401 re-mints once and retries. */
async function authedFetch(tokens, url, init = {}) {
  let token = await tokens.get();
  const withAuth = (t) => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` },
  });
  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    tokens.invalidate(token);
    token = await tokens.get();
    res = await fetch(url, withAuth(token));
  }
  return res;
}

async function submitTask(tokens) {
  const res = await authedFetch(tokens, `${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: QUESTION }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, taskId: body.task_id };
}

async function pollTask(tokens, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await authedFetch(tokens, `${GATEWAY_URL}/v1/tasks/${taskId}`);
    const body = await res.json().catch(() => ({}));
    if (body.status === 'completed') return 'completed';
    if (body.status === 'failed') return 'failed';
    if (Date.now() > deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** One task lifecycle; returns { ok, ms }. */
async function runOne(tokens, timeoutMs) {
  const start = Date.now();
  try {
    const sub = await submitTask(tokens);
    if (sub.status !== 202 || !sub.taskId) return { ok: false, ms: Date.now() - start };
    const outcome = await pollTask(tokens, sub.taskId, timeoutMs);
    return { ok: outcome === 'completed', ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(results) {
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const ok = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok,
    successRate: results.length ? ok / results.length : 0,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    max: lat.at(-1) ?? 0,
  };
}

async function drive({ rps, duration, timeout }) {
  const tokens = makeTokenProvider();
  await tokens.get(); // fail fast if the token service is unreachable
  const results = [];
  const inflight = new Set();
  const intervalMs = Math.max(1, Math.round(1000 / rps));
  const end = Date.now() + duration * 1000;
  process.stdout.write(`driving ~${rps} rps for ${duration}s (per-task timeout ${timeout}ms)\n`);

  while (Date.now() < end) {
    const p = runOne(tokens, timeout).then((r) => {
      results.push(r);
      inflight.delete(p);
      const tag = r.ok ? 'ok' : 'FAIL';
      process.stdout.write(`  [${results.length}] ${tag} ${r.ms}ms\n`);
    });
    inflight.add(p);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await Promise.all(inflight);
  return results;
}

function reportAndGate(label, results, opts, extraChecks = []) {
  const s = summarize(results);
  process.stdout.write(
    `\n=== ${label} summary ===\n` +
      `  tasks: ${s.total}  ok: ${s.ok}  success: ${(s.successRate * 100).toFixed(2)}%\n` +
      `  latency ms  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}\n`,
  );
  const breaches = [];
  if (s.total === 0) breaches.push('no tasks were submitted (is the platform up?)');
  if (s.successRate < opts.success)
    breaches.push(
      `success ${(s.successRate * 100).toFixed(2)}% < target ${(opts.success * 100).toFixed(2)}%`,
    );
  if (s.p95 > opts.p95) breaches.push(`p95 ${s.p95}ms > SLO ${opts.p95}ms`);
  for (const c of extraChecks) if (c) breaches.push(c);

  if (breaches.length) {
    process.stdout.write(`\nSLO BREACH:\n${breaches.map((b) => `  - ${b}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nall SLOs within target.\n');
}

async function main() {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  if (mode !== 'load' && mode !== 'soak') {
    process.stderr.write(
      'usage: node tests/load/task-burst.mjs <load|soak> [--rps N] [--duration S] ' +
        '[--p95 MS] [--success RATIO] [--timeout MS] [--drift RATIO]\n',
    );
    process.exit(2);
  }

  const results = await drive(opts);

  if (mode === 'soak') {
    // Drift check: p95 of the last quartile must not exceed the first quartile
    // by more than --drift (a proxy for latency creep / resource leak). Backlog
    // growth manifests as rising latency here and in the queue-depth dashboard.
    const q = Math.max(1, Math.floor(results.length / 4));
    const firstP95 = summarize(results.slice(0, q)).p95;
    const lastP95 = summarize(results.slice(-q)).p95;
    const drifted =
      firstP95 > 0 && lastP95 > firstP95 * opts.drift
        ? `p95 drifted ${firstP95}ms → ${lastP95}ms (> ${opts.drift}x) — possible backlog growth / leak`
        : null;
    process.stdout.write(
      `\nsoak drift: first-quartile p95=${firstP95}ms  last-quartile p95=${lastP95}ms\n`,
    );
    reportAndGate('soak', results, opts, [drifted]);
  } else {
    reportAndGate('load', results, opts);
  }
}

main().catch((err) => {
  process.stderr.write(`harness error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
