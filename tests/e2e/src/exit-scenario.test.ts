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
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCard, AuditEvent, TaskResult } from '@acp/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  JAEGER_URL,
  KNOWLEDGE_URL,
  REGISTRY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const execFileAsync = promisify(execFile);

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

async function auditEvents(
  taskId?: string,
  tenant = 'acme',
  eventType?: string,
): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  // The full CI suite shares one audit stream and the store returns the OLDEST
  // `limit` events (default 200, ORDER BY occurred_at ASC). Once earlier files
  // (e.g. the deployment suite driving steady traffic) saturate the stream, a
  // later file's own events fall outside an unfiltered 200-event window. Filter
  // by event_type server-side and lift the limit to the audit cap (1000) so each
  // query stays bounded to its own event class regardless of total volume.
  const params = new URLSearchParams({ tenant, limit: '1000' });
  if (taskId !== undefined) params.set('task_id', taskId);
  if (eventType !== undefined) params.set('event_type', eventType);
  const url = `${AUDIT_URL}/v1/events?${params.toString()}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 1 exit scenario', () => {
  it('registers and activates the knowledge agent (signed card, lifecycle gates)', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'python', 'agents', 'knowledge', 'manifest.yaml'),
      'knowledge-agent',
      writeToken,
      'phase 1 walking skeleton promotion',
    );
  });

  it('records the eval baseline on the agent card (Evaluation Service v0)', async () => {
    // The same CLI CI uses; svc-ci's existing registry:write grant suffices.
    execFileSync(
      'node',
      [
        join(repoRoot, 'apps', 'evaluation', 'dist', 'main.js'),
        'record',
        '--baseline',
        join(repoRoot, 'python', 'agents', 'knowledge', 'evals', 'baseline.json'),
        '--registry',
        REGISTRY_URL,
        '--token-url',
        TOKEN_URL,
        '--client-id',
        'svc-ci',
        '--client-secret',
        'ci-dev-secret',
      ],
      { cwd: repoRoot },
    );

    const readToken = await ciToken('acp:registry', 'registry:read');
    const res = await fetch(`${REGISTRY_URL}/v1/agents/knowledge-agent`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(200);
    const card = (await res.json()) as AgentCard;
    // The previous block activated the agent; recording a baseline must not
    // touch lifecycle state.
    expect(card.lifecycle_state).toBe('active');
    expect(card.eval_baseline?.schema).toBe('acp-eval-baseline/v1');
    expect(card.eval_baseline?.agent_version).toBe('0.1.0');
    expect(card.eval_baseline?.metrics.pass_rate).toBe(1);
    expect(card.eval_baseline?.suite.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Registry events land on the platform tenant; the audit consumer is
    // asynchronous — give the stream a moment.
    let recorded: AuditEvent | undefined;
    for (let i = 0; i < 20 && recorded === undefined; i++) {
      recorded = (await auditEvents(undefined, 'platform', 'agent.baseline_recorded')).find(
        (e) => e.event_type === 'agent.baseline_recorded',
      );
      if (recorded === undefined) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(recorded, 'no agent.baseline_recorded audit event').toBeDefined();
    expect(recorded!.artifacts?.agent_id).toBe('knowledge-agent');
    expect((recorded!.details as { suite_digest?: string }).suite_digest).toMatch(/^sha256:/);
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
    const corpusEvents = (await auditEvents(undefined, 'acme', 'corpus.mutation')).filter(
      (e) => e.event_type === 'corpus.mutation',
    );
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
    const killEvents = (await auditEvents(undefined, 'platform', 'killswitch.activated')).filter(
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
