/**
 * Multi-tenancy GA E2E (Phase 4 item 1). Proves the four tenant-isolation
 * claims against the live dev stack, with globex as the second tenant:
 *
 *  0. Provisioning invariants: the NATS accounts generator renders globex
 *     with an EXACT per-tenant export and FAILS on widened exports, shared
 *     accounts, platform-subject exports, and non-bijective registries.
 *  1. Provisioning live: the globex agent client mints an acp:bus token and
 *     connects through the auth callout into TENANT_GLOBEX.
 *  2. Isolation: an acme task is invisible to a globex caller (404); a globex
 *     bus session cannot publish into acp.acme.> nor subscribe acp.acme.>,
 *     and the acme session is confined symmetrically.
 *  3. Per-tenant budgets: with globex capped tiny, the reservation that no
 *     longer fits is refused 402 while acme keeps submitting 202; the ledger
 *     consumer books the completed task and frees its reservation.
 *  4. Per-tenant kill switch: haltTenant(globex) 503s NEW globex intake,
 *     refuses NEW globex bus sessions, auto-cancels the in-flight globex
 *     task (trigger tenant_killswitch), leaves acme untouched; resume
 *     restores intake.
 *
 * beforeAll resets ONLY globex's budget rows (never audit rows — the hash
 * chain must survive). Requires the NATS container recreated on the generated
 * accounts conf: docker compose -f deploy/compose/docker-compose.yml -p acp-dev up -d
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { KillSwitchControl } from '@acp/service-kit';
import { connect, Events, tokenAuthenticator, type NatsConnection } from 'nats';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The REAL reserve primitive (the atomic conditional UPDATE under the
// (tenant, period) row lock) — exercised concurrently below against the live
// pg. Type-only imports from its module are erased, so this pulls in only
// @acp/service-kit + pg at runtime.
import { PgBudgetAdmission } from '../../../apps/gateway/src/budget.js';
import {
  AUDIT_URL,
  GATEWAY_URL,
  TOKEN_URL,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const NATS_URL = 'nats://localhost:4222';
const DB_URL = process.env.ACP_DATABASE_URL ?? 'postgres://acp:acp-dev-password@localhost:5432/acp';
const QUESTION = 'What does our policy say about change freezes?';
/** globex cap for this run (matches deploy/dev/tenant-budgets.json). */
const GLOBEX_CAP_MICROS = 500_000; // $0.50

let platform: ChildProcess | undefined;
let control: NatsConnection | undefined;
let pool: pg.Pool | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(clientId: string, clientSecret: string, audience: string, scope?: string) {
  const res = await fetch(`${TOKEN_URL}/v1/token`, {
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
  if (res.status !== 200) return { status: res.status, body };
  return { status: 200, token: (JSON.parse(body) as { access_token: string }).access_token, body };
}

async function mustToken(clientId: string, secret: string, audience: string, scope?: string) {
  const res = await getToken(clientId, secret, audience, scope);
  expect(res.status, res.body).toBe(200);
  return res.token!;
}

const acmeJane = () => mustToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
const globexJane = () => mustToken('cli-jane-globex', 'jane-globex-dev-secret', 'acp:gateway');

async function submit(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; task_id: string | undefined; text: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const task_id =
    res.status === 202 ? (JSON.parse(text) as { task_id: string }).task_id : undefined;
  return { status: res.status, task_id, text };
}

async function taskView(
  token: string,
  taskId: string,
): Promise<{ status: number; body: { status?: string; result?: TaskResult | null } }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function waitForTerminal(
  token: string,
  taskId: string,
  timeoutMs = 180_000,
): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await taskView(token, taskId);
    if (view.body.status === 'completed' || view.body.status === 'failed') {
      expect(view.body.result, `task ${taskId} ${view.body.status} with no result`).toBeTruthy();
      return view.body.result!;
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} still ${view.body.status} after ${timeoutMs}ms`);
    }
    await sleep(1_000);
  }
}

/** Connects with a bus token, failing fast (no reconnect) so auth refusals reject. */
function busConnect(token: string): Promise<NatsConnection> {
  return connect({
    servers: NATS_URL,
    authenticator: tokenAuthenticator(() => token),
    reconnect: false,
    timeout: 5_000,
  });
}

/** Collects PERMISSIONS_VIOLATION-class errors from a live bus session. */
function collectErrors(nc: NatsConnection): string[] {
  const errors: string[] = [];
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Error) errors.push(JSON.stringify(s));
    }
  })();
  return errors;
}

async function auditEvents(tenant: string, eventType: string): Promise<AuditEvent[]> {
  const token = await mustToken('svc-ci', 'ci-dev-secret', 'acp:audit', 'audit:read');
  const res = await fetch(
    `${AUDIT_URL}/v1/events?tenant=${tenant}&event_type=${encodeURIComponent(eventType)}&limit=1000`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

beforeAll(async () => {
  platform = await startPlatform();
  // Platform bypass user (in auth_users) — used only to drive the kill switch.
  control = await connect({ servers: NATS_URL, user: 'token', pass: 'token-dev-password' });
  pool = new pg.Pool({ connectionString: DB_URL });
  // Reset ONLY our own tenant's budget lane so reruns are deterministic:
  // globex reservations dropped, its current-period row zeroed at the known
  // cap. Audit rows are NEVER touched (hash chain), acme's lane untouched.
  await pool.query(`DELETE FROM tenant_budget_reservation WHERE tenant = 'globex'`);
  await pool.query(
    `INSERT INTO tenant_budget (tenant, period_start, cap_micros, committed_micros, reserved_micros)
     VALUES ('globex', date_trunc('month', now() at time zone 'utc')::date, $1, 0, 0)
     ON CONFLICT (tenant, period_start)
       DO UPDATE SET cap_micros = $1, committed_micros = 0, reserved_micros = 0`,
    [GLOBEX_CAP_MICROS],
  );
  // A prior aborted run may have left the tenant halted — always start clean.
  const ks = await KillSwitchControl.open(control);
  await ks.resumeTenant('globex');
}, 300_000);

afterAll(async () => {
  // Never leave globex halted for the next suite/file.
  try {
    if (control !== undefined) {
      const ks = await KillSwitchControl.open(control);
      await ks.resumeTenant('globex');
    }
  } catch {
    // best effort
  }
  await control?.close();
  await pool?.end();
  stopPlatform(platform);
});

describe('0. NATS account generator invariants (validator must fail on widening)', () => {
  interface Gen {
    renderAccountsConf: (registry: unknown) => string;
  }
  // The generator is an untyped .mjs script; the dynamic import is `any`.
  const loadGen = (): Promise<Gen> =>
    import(pathToFileURL(join(repoRoot, 'scripts', 'gen-nats-accounts.mjs')).href) as Promise<Gen>;

  it('renders globex with an EXACT per-tenant export and per-tenant PLATFORM import', async () => {
    const gen = await loadGen();
    const conf = gen.renderAccountsConf([
      { tenant: 'acme', account: 'TENANT_ACME' },
      { tenant: 'globex', account: 'TENANT_GLOBEX' },
    ]);
    expect(conf).toContain('TENANT_GLOBEX');
    expect(conf).toContain('exports: [{ stream: "acp.globex.>" }]');
    expect(conf).toContain('{ stream: { account: TENANT_GLOBEX, subject: "acp.globex.>" } }');
    // No wildcarded tenant subject anywhere.
    expect(conf).not.toMatch(/"acp\.\*/);
  });

  it('fails on a widened/dotted tenant, shared account, reserved account, and duplicates', async () => {
    const gen = await loadGen();
    expect(() => gen.renderAccountsConf([{ tenant: 'a.b', account: 'T_A' }])).toThrow(/not valid/);
    expect(() => gen.renderAccountsConf([{ tenant: '*', account: 'T_A' }])).toThrow(/not valid/);
    expect(() =>
      gen.renderAccountsConf([
        { tenant: 'a', account: 'SHARED' },
        { tenant: 'b', account: 'SHARED' },
      ]),
    ).toThrow(/shared account|claimed by more than one/);
    expect(() => gen.renderAccountsConf([{ tenant: 'a', account: 'PLATFORM' }])).toThrow(
      /reserved/,
    );
    expect(() =>
      gen.renderAccountsConf([
        { tenant: 'a', account: 'T_A' },
        { tenant: 'a', account: 'T_A2' },
      ]),
    ).toThrow(/duplicate tenant/);
  });
});

describe('1. provisioning: globex is a live tenant', () => {
  it('the globex agent client mints acp:bus and connects through the callout', async () => {
    const token = await mustToken(
      'agent-knowledge-agent-globex',
      'agent-knowledge-globex-dev-secret',
      'acp:bus',
    );
    const nc = await busConnect(token);
    nc.publish('acp.globex.telemetry.mt-e2e-provision', new TextEncoder().encode('{}'));
    await nc.flush();
    await nc.close();
  });

  it('a globex agent session cannot self-attest audit (forge task.completed) (B1)', async () => {
    // The within-tenant budget cap is only sound because agents cannot publish
    // audit at all — only the platform attests task.completed. A globex session
    // publishing its OWN tenant's audit.task.completed is refused by the
    // account boundary, so a forged zero-cost completion can never reach the
    // ledger to drop the real charge.
    const token = await mustToken(
      'agent-knowledge-agent-globex',
      'agent-knowledge-globex-dev-secret',
      'acp:bus',
    );
    const nc = await busConnect(token);
    const errors = collectErrors(nc);
    nc.publish('acp.globex.audit.task.completed', new TextEncoder().encode('{}'));
    await nc.flush();
    await sleep(750);
    const joined = errors.join(' ');
    expect(joined).toMatch(/PERMISSIONS_VIOLATION/i);
    expect(joined).toContain('acp.globex.audit.task.completed');
    await nc.close();
  });
});

describe('2. isolation between acme and globex', () => {
  it('an acme task reads as ABSENT (404) to a globex caller', async () => {
    const acme = await submit(await acmeJane(), { text: QUESTION });
    expect(acme.status, acme.text).toBe(202);

    const foreign = await taskView(await globexJane(), acme.task_id!);
    expect(foreign.status).toBe(404);
    // The owner still sees it.
    const own = await taskView(await acmeJane(), acme.task_id!);
    expect(own.status).toBe(200);
  });

  it('a globex bus session cannot publish or subscribe into acp.acme.> (and vice versa)', async () => {
    const globexToken = await mustToken(
      'agent-knowledge-agent-globex',
      'agent-knowledge-globex-dev-secret',
      'acp:bus',
    );
    const globexNc = await busConnect(globexToken);
    const globexErrors = collectErrors(globexNc);
    globexNc.publish('acp.acme.audit.mt-e2e-crosstenant', new TextEncoder().encode('{}'));
    globexNc.subscribe('acp.acme.>', { callback: () => undefined });
    await globexNc.flush();
    await sleep(750);
    const globexJoined = globexErrors.join(' ');
    expect(globexJoined).toMatch(/PERMISSIONS_VIOLATION/i);
    expect(globexJoined).toContain('acp.acme.audit.mt-e2e-crosstenant');
    expect(globexJoined).toContain('acp.acme.>');
    await globexNc.close();

    const acmeToken = await mustToken(
      'agent-knowledge-agent',
      'agent-knowledge-dev-secret',
      'acp:bus',
    );
    const acmeNc = await busConnect(acmeToken);
    const acmeErrors = collectErrors(acmeNc);
    acmeNc.publish('acp.globex.audit.mt-e2e-crosstenant', new TextEncoder().encode('{}'));
    acmeNc.subscribe('acp.globex.>', { callback: () => undefined });
    await acmeNc.flush();
    await sleep(750);
    const acmeJoined = acmeErrors.join(' ');
    expect(acmeJoined).toMatch(/PERMISSIONS_VIOLATION/i);
    expect(acmeJoined).toContain('acp.globex.');
    await acmeNc.close();
  });
});

describe('3. per-tenant budget enforcement', () => {
  let firstGlobexTask: string;

  it('admits until the cap, then 402s globex while acme still submits', async () => {
    // Reservation 1: $0.30 of the $0.50 cap → fits.
    const first = await submit(await globexJane(), {
      text: QUESTION,
      budget: { max_cost_usd: 0.3 },
    });
    expect(first.status, first.text).toBe(202);
    firstGlobexTask = first.task_id!;

    // Reservation 2: another $0.30 would breach 0.30+0.30 > 0.50 → 402.
    const second = await submit(await globexJane(), {
      text: QUESTION,
      budget: { max_cost_usd: 0.3 },
    });
    expect(second.status, second.text).toBe(402);
    expect(second.text).toContain('over budget');

    // acme (large cap) is untouched by globex's exhaustion.
    const acme = await submit(await acmeJane(), { text: QUESTION });
    expect(acme.status, acme.text).toBe(202);

    // The refusal is attested: task.rejected{budget_exhausted} for globex.
    const rejected = (await auditEvents('globex', 'task.rejected')).filter(
      (e) => (e.details as { reason?: string } | undefined)?.reason === 'budget_exhausted',
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.at(-1)!.actor.principal).toBe('user:jane.globex');
  });

  it('the ledger consumer books the completed task and frees its reservation', async () => {
    await waitForTerminal(await globexJane(), firstGlobexTask);
    // The durable consumer moves reserved → committed keyed by task_id.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await pool!.query(
        `SELECT (SELECT count(*) FROM tenant_budget_reservation WHERE task_id = $1) AS reservations,
                (SELECT count(*) FROM tenant_budget_charge WHERE task_id = $1) AS charges`,
        [firstGlobexTask],
      );
      const row = res.rows[0] as { reservations: string; charges: string };
      if (Number(row.reservations) === 0 && Number(row.charges) === 1) break;
      if (Date.now() > deadline) {
        throw new Error(
          `budget ledger never booked task ${firstGlobexTask}: ${JSON.stringify(row)}`,
        );
      }
      await sleep(1_000);
    }
    // Invariant: committed + reserved never exceeds the cap.
    const budget = await pool!.query(
      `SELECT cap_micros, committed_micros, reserved_micros FROM tenant_budget
        WHERE tenant='globex' ORDER BY period_start DESC LIMIT 1`,
    );
    const b = budget.rows[0] as {
      cap_micros: string;
      committed_micros: string;
      reserved_micros: string;
    };
    expect(Number(b.committed_micros) + Number(b.reserved_micros)).toBeLessThanOrEqual(
      Number(b.cap_micros),
    );
  });
});

describe('3b. concurrent reserve under a tight cap (anti-TOCTOU)', () => {
  // A dedicated pg-only tenant so this never disturbs globex's budget lane or
  // any audit rows. reserve() is the gateway's real primitive.
  const TENANT = 'mtconcurrency';
  const CAP_MICROS = 100_000; // $0.10
  const EST_MICROS = 30_000; // $0.03 → exactly 3 of these fit (90k ≤ 100k, 120k > 100k)
  const FANOUT = 8;

  it('admits exactly the fitting set; committed + reserved never exceeds the cap', async () => {
    const admission = new PgBudgetAdmission({ pool: pool! });
    const period = new Date().toISOString().slice(0, 8) + '01';
    // Fresh cap row for this run.
    await pool!.query(`DELETE FROM tenant_budget_reservation WHERE tenant = $1`, [TENANT]);
    await pool!.query(`DELETE FROM tenant_budget WHERE tenant = $1`, [TENANT]);
    await pool!.query(
      `INSERT INTO tenant_budget (tenant, period_start, cap_micros, committed_micros, reserved_micros)
       VALUES ($1, date_trunc('month', now() at time zone 'utc')::date, $2, 0, 0)`,
      [TENANT, CAP_MICROS],
    );
    try {
      // Fire FANOUT reserves concurrently — they serialize on the (tenant,
      // period) row lock, each re-evaluating the predicate against the
      // post-predecessor state (no read-then-write window).
      const outcomes = await Promise.all(
        Array.from({ length: FANOUT }, () => admission.reserve(TENANT, randomUUID(), EST_MICROS)),
      );
      const admitted = outcomes.filter((o) => o === 'ok').length;
      const refused = outcomes.filter((o) => o === 'over_budget').length;
      expect(admitted).toBe(Math.floor(CAP_MICROS / EST_MICROS)); // exactly 3
      expect(refused).toBe(FANOUT - admitted);

      const row = (
        await pool!.query<{
          committed_micros: string;
          reserved_micros: string;
          cap_micros: string;
        }>(
          `SELECT committed_micros, reserved_micros, cap_micros FROM tenant_budget
            WHERE tenant = $1 AND period_start = $2`,
          [TENANT, period],
        )
      ).rows[0]!;
      // The invariant the cap exists to guarantee, after a concurrent storm.
      expect(Number(row.reserved_micros)).toBe(admitted * EST_MICROS);
      expect(Number(row.committed_micros) + Number(row.reserved_micros)).toBeLessThanOrEqual(
        Number(row.cap_micros),
      );
    } finally {
      await pool!.query(`DELETE FROM tenant_budget_reservation WHERE tenant = $1`, [TENANT]);
      await pool!.query(`DELETE FROM tenant_budget WHERE tenant = $1`, [TENANT]);
    }
  });
});

describe('4. per-tenant kill switch', () => {
  it('halts exactly globex: intake 503, bus refused, in-flight cancelled; acme untouched; resume restores', async () => {
    if (control === undefined) throw new Error('no control connection');
    const ks = await KillSwitchControl.open(control);

    // An in-flight globex task the canceller must catch (submitted pre-halt).
    const inflight = await submit(await globexJane(), {
      text: QUESTION,
      budget: { max_cost_usd: 0.1 },
    });
    expect(inflight.status, inflight.text).toBe(202);

    await ks.haltTenant('globex', 'mt-e2e drill', 'svc:agent-ci');
    // Give the watchers a moment to see the KV write.
    await sleep(1_500);

    try {
      // NEW globex intake is refused, attested task.rejected{tenant_halt}.
      const refused = await submit(await globexJane(), { text: QUESTION });
      expect(refused.status, refused.text).toBe(503);
      expect(refused.text).toContain('tenant globex');

      // acme intake is untouched by globex's halt.
      const acme = await submit(await acmeJane(), { text: QUESTION });
      expect(acme.status, acme.text).toBe(202);

      // NEW globex bus sessions are refused at the callout.
      const busToken = await getToken(
        'agent-knowledge-agent-globex',
        'agent-knowledge-globex-dev-secret',
        'acp:bus',
      );
      if (busToken.status === 200) {
        await expect(busConnect(busToken.token!)).rejects.toThrow();
      }

      // The in-flight globex task is auto-cancelled by the tenant sweep and
      // returns an HONEST cancelled result (drain-then-unwind, not a fault).
      const result = await waitForTerminal(await globexJane(), inflight.task_id!);
      expect(result.status).toBe('cancelled');
      const cancels = (await auditEvents('globex', 'task.cancel_requested')).filter(
        (e) =>
          e.reason?.task_id === inflight.task_id &&
          (e.details as { trigger?: string } | undefined)?.trigger === 'tenant_killswitch',
      );
      expect(cancels.length, 'no tenant_killswitch cancel audit').toBeGreaterThan(0);

      // The halt refusal was attested.
      const rejected = (await auditEvents('globex', 'task.rejected')).filter(
        (e) => (e.details as { reason?: string } | undefined)?.reason === 'tenant_halt',
      );
      expect(rejected.length).toBeGreaterThan(0);
    } finally {
      await ks.resumeTenant('globex');
    }

    // Resume: globex intake recovers within the propagation window.
    let recovered = 0;
    for (let i = 0; i < 15; i++) {
      const res = await submit(await globexJane(), {
        text: QUESTION,
        budget: { max_cost_usd: 0.05 },
      });
      if (res.status === 202) {
        recovered = 202;
        break;
      }
      await sleep(1_000);
    }
    expect(recovered).toBe(202);
  }, 300_000);
});
