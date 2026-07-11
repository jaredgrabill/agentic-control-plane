/**
 * The Phase 1 exit scenario (ROADMAP.md), verified end to end — nothing
 * mocked in the control path:
 *
 *   "What does our policy say about change freezes?" → cited answer;
 *   trace shows gateway → workflow → agent → retrieval; audit shows the
 *   full delegation chain; suspending the agent stops traffic in seconds.
 *
 * Prerequisites: `make dev` (substrate), `pnpm build`, `uv sync` (in
 * python/). The suite boots the platform itself via scripts/run-platform.mjs.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..', '..', '..');

const TOKEN_URL = 'http://localhost:7101';
const GATEWAY_URL = 'http://localhost:7100';
const REGISTRY_URL = 'http://localhost:7102';
const AUDIT_URL = 'http://localhost:7104';
const KNOWLEDGE_URL = 'http://localhost:7105';
const JAEGER_URL = 'http://localhost:16686';

const QUESTION = 'What does our policy say about change freezes?';

let platform: ChildProcess;

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
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const ciToken = (audience: string, scope: string) =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);
const janeToken = () => getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');

async function submitTask(text: string): Promise<{ task_id: string; status: number }> {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text }),
  });
  const body = (await res.json()) as { task_id: string };
  return { task_id: body.task_id, status: res.status };
}

async function waitForResult(taskId: string, timeoutMs = 90_000): Promise<TaskResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (body.status === 'completed' || body.status === 'failed') {
      expect(body.result, `task ${taskId} ${body.status} with no result`).not.toBeNull();
      return body.result!;
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} still ${body.status} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function auditEvents(taskId?: string, tenant = 'acme'): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const url = `${AUDIT_URL}/v1/events?tenant=${tenant}${taskId === undefined ? '' : `&task_id=${taskId}`}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

beforeAll(async () => {
  // Fail fast with an actionable message if the substrate isn't up.
  try {
    await fetch('http://localhost:8222/healthz');
  } catch {
    throw new Error('dev stack is not running — start it with `make dev` first');
  }

  platform = spawn('node', [join(repoRoot, 'scripts', 'run-platform.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('platform never became ready'));
    }, 180_000);
    platform.stdout!.on('data', (d: Buffer) => {
      process.stdout.write(d);
      if (d.toString().includes('PLATFORM_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    platform.on('exit', (code) => {
      reject(new Error(`platform exited early: ${code}`));
    });
  });
}, 300_000);

afterAll(() => {
  if (process.platform === 'win32' && platform.pid !== undefined) {
    // TerminateProcess does not cascade; take down the whole service tree.
    spawn('taskkill', ['/pid', String(platform.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    platform.kill();
  }
});

describe('phase 1 exit scenario', () => {
  it('registers and activates the knowledge agent (signed card, lifecycle gates)', async () => {
    const manifest = parseYaml(
      readFileSync(join(repoRoot, 'python', 'agents', 'knowledge', 'manifest.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');

    const register = await fetch(`${REGISTRY_URL}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ manifest, version: '0.1.0' }),
    });
    expect(register.status, await register.clone().text()).toBe(201);
    const card = (await register.json()) as { lifecycle_state: string; card_signature: string };
    expect(card.lifecycle_state).toBe('registered');
    expect(card.card_signature).toBeTruthy();

    const activate = await fetch(`${REGISTRY_URL}/v1/agents/knowledge-agent/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ state: 'active', reason: 'phase 1 walking skeleton promotion' }),
    });
    expect(activate.status, await activate.clone().text()).toBe(200);
  });

  it('ingests the acme-corp corpus with lineage ledger blocks', async () => {
    const token = await ciToken('acp:knowledge', 'knowledge:ingest');
    for (const sourceId of ['policy-docs', 'eng-standards', 'runbooks']) {
      const res = await fetch(`${KNOWLEDGE_URL}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ source_id: sourceId }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { documents: number; indexed: number };
      expect(body.documents).toBeGreaterThan(0);
    }

    // Corpus mutations are on the audit stream: the ingest ledger exists
    // from day one, with the raw chunk text and versions.
    const corpusEvents = (await auditEvents()).filter((e) => e.event_type === 'corpus.mutation');
    expect(corpusEvents.length).toBeGreaterThan(10);
    const block = corpusEvents[0]!;
    expect(block.artifacts?.lineage_ids?.[0]).toMatch(/^[0-9a-f]{8}-/);
    expect((block.details as { content?: string }).content).toBeTruthy();
    expect((block.details as { chunker_version?: string }).chunker_version).toBe(
      'structure-aware@1',
    );
  });

  let taskId: string;

  it('answers the change-freeze question with citations, through a real JWT', async () => {
    const submitted = await submitTask(QUESTION);
    expect(submitted.status).toBe(202);
    taskId = submitted.task_id;

    const result = await waitForResult(taskId);
    expect(result.status, JSON.stringify(result.error ?? {})).toBe('completed');
    expect(result.answer!.text.toLowerCase()).toContain('fiscal quarter');
    expect(result.answer!.confidence).toBeGreaterThan(0.35);

    const citations = result.answer!.citations;
    expect(citations.length).toBeGreaterThan(0);
    const changePolicy = citations.find((c) => c.doc_id === 'policy/change-management');
    expect(changePolicy, 'answer must cite the change management policy').toBeDefined();
    expect(changePolicy!.version).toBe('3.2.0');
    expect(changePolicy!.effective_date).toBe('2026-01-15');
    expect(changePolicy!.lineage_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('rejects unauthenticated and unauthorized submissions (no placeholder security)', async () => {
    const anon = await fetch(`${GATEWAY_URL}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: QUESTION }),
    });
    expect(anon.status).toBe(401);

    const forged = await fetch(`${GATEWAY_URL}/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.',
      },
      body: JSON.stringify({ text: QUESTION }),
    });
    expect(forged.status).toBe(401);
  });

  it('recorded the full delegation chain and policy decisions in the audit trail', async () => {
    // The audit consumer is asynchronous; give the stream a moment.
    let events: AuditEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events = await auditEvents(taskId);
      if (events.length >= 5) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const types = events.map((e) => e.event_type);
    for (const expected of [
      'task.submitted',
      'step.dispatched',
      'policy.decision',
      'retrieval.served',
      'step.completed',
    ]) {
      expect(types, `missing ${expected} in [${types.join(', ')}]`).toContain(expected);
    }

    const retrieval = events.find((e) => e.event_type === 'retrieval.served')!;
    expect(retrieval.actor.delegation_chain?.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:knowledge-agent@0.1.0',
    ]);
    expect(retrieval.artifacts?.lineage_ids?.length).toBeGreaterThan(0);

    const decisions = events.filter((e) => e.event_type === 'policy.decision');
    expect(decisions.length).toBeGreaterThanOrEqual(2); // delegation + retrieval PEPs
    for (const d of decisions) {
      expect(d.reason?.policy?.decision).toBe('allow');
      expect(d.reason?.policy?.bundle_version).toMatch(/^2026\.07\+[0-9a-f]{12}$/);
    }
  });

  it('produced one trace across gateway → workflow → agent → retrieval', async () => {
    let services = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${JAEGER_URL}/api/traces?service=gateway&limit=40&lookback=1h`);
      const body = (await res.json()) as {
        data: { processes: Record<string, { serviceName: string }> }[] | null;
      };
      for (const traceData of body.data ?? []) {
        const names = new Set(Object.values(traceData.processes).map((p) => p.serviceName));
        if (names.size > services.size) services = names;
        if (
          names.has('gateway') &&
          names.has('orchestrator') &&
          names.has('knowledge-agent') &&
          names.has('knowledge')
        ) {
          return; // the full path is on one trace
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect.fail(
      `no single trace spans the full path; best trace covered [${[...services].join(', ')}] — ` +
        'expected gateway, orchestrator, knowledge-agent, knowledge',
    );
  });

  it('kill switch tier 1: suspending the agent stops new traffic in under 10 seconds', async () => {
    const suspendStart = Date.now();
    await execFileAsync(
      'node',
      [
        join(repoRoot, 'scripts', 'kill-switch.mjs'),
        'suspend',
        'knowledge-agent',
        '--reason',
        'e2e drill',
      ],
      { cwd: repoRoot },
    );

    const submitted = await submitTask(QUESTION);
    expect(submitted.status).toBe(202);
    const result = await waitForResult(submitted.task_id, 30_000);
    const stoppedAfterMs = Date.now() - suspendStart;

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('suspended or not yet promoted');
    expect(stoppedAfterMs, 'suspension must stop new traffic in <10s').toBeLessThan(10_000);

    // Audit knows the switch flipped (registry events are platform-tenant).
    const killEvents = (await auditEvents(undefined, 'platform')).filter(
      (e) => e.event_type === 'killswitch.activated',
    );
    expect(killEvents.length).toBeGreaterThan(0);

    // Reinstate so repeated local runs start from a clean state.
    await execFileAsync(
      'node',
      [
        join(repoRoot, 'scripts', 'kill-switch.mjs'),
        'reinstate',
        'knowledge-agent',
        '--reason',
        'e2e drill complete',
      ],
      { cwd: repoRoot },
    );
    const recovered = await submitTask(QUESTION);
    const recoveredResult = await waitForResult(recovered.task_id);
    expect(recoveredResult.status).toBe('completed');
  });
});
