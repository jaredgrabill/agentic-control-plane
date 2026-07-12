/**
 * Phase 2 Item 5 scenario: the Tool Gateway as the PEP for tool calls,
 * driven directly (IDE-shaped MCP clients and forged delegated tokens)
 * rather than through the orchestrator — the agent-path traversal is
 * asserted in tool-agents.test.ts on the cost-spike flow.
 *
 * Covers: 401 hygiene at the door; a Cedar denial (agent identity calling
 * a tool outside its manifest scopes) that never reaches the upstream; a
 * user searching the governed corpus through the gateway's MCP door with
 * BOTH audit events (gateway tool.called + knowledge retrieval.served)
 * carrying the clean [user:jane.doe] chain — which pins the token
 * service's no-op-act exchange fix; and the token-bucket rate limit on
 * the knowledge server (burst 5).
 */

import { randomUUID } from 'node:crypto';
import { type ChildProcess } from 'node:child_process';
import type { AuditEvent } from '@acp/protocol';
import { McpToolClient, type ToolResponse } from '@acp/tool-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  KNOWLEDGE_URL,
  TOKEN_URL,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const TOOL_GATEWAY_URL = 'http://localhost:7106';

let platform: ChildProcess | undefined;

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
/** Jane, IDE-shaped: a plain user token aimed at the tools audience. */
const janeToolsToken = () =>
  getToken('cli-jane', 'jane-dev-secret', 'acp:tools', 'knowledge:search:read');

async function auditEvents(taskId: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

async function waitForAudit(
  taskId: string,
  ready: (events: AuditEvent[]) => boolean,
): Promise<AuditEvent[]> {
  let events: AuditEvent[] = [];
  for (let i = 0; i < 20; i++) {
    events = await auditEvents(taskId);
    if (ready(events)) return events;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return events;
}

const gatewayClient = (server: string) =>
  new McpToolClient({ servers: { [server]: { url: `${TOOL_GATEWAY_URL}/mcp/${server}` } } });

interface ToolError {
  errorClass?: string;
  message?: string;
  details?: { retry_after_s?: number };
}

async function failureOf(promise: Promise<unknown>): Promise<ToolError> {
  const outcome = await promise.then(
    () => undefined,
    (err: unknown) => err as ToolError,
  );
  expect(outcome, 'expected the tool call to fail').toBeDefined();
  return outcome!;
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 2 tool gateway scenario', () => {
  it('401 hygiene: no token and a wrong-audience token are both refused at the door', async () => {
    const anonymous = await failureOf(
      gatewayClient('knowledge').call('knowledge', 'knowledge_search', { query: 'anything' }),
    );
    expect(anonymous.errorClass).toBe('policy_denied');
    expect(anonymous.message).toBe('tool server knowledge refused the call (401)');

    // A perfectly valid platform token for the WRONG audience (acp:gateway)
    // must not open the tools door.
    const gatewayAudience = await getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
    const wrongAudience = await failureOf(
      gatewayClient('knowledge').call(
        'knowledge',
        'knowledge_search',
        { query: 'anything' },
        { delegatedToken: gatewayAudience },
      ),
    );
    expect(wrongAudience.errorClass).toBe('policy_denied');
  });

  it('the old acp:agent:{id} delegated-token shape is refused at the door (post-0c flip)', async () => {
    // Before 0c the gateway accepted acp:agent:* audiences; now a stolen
    // delegated step token opens nothing — audience refused, no Cedar reached.
    const subjectToken = await getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
    const exchange = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: subjectToken,
        audience: 'acp:agent:cloud-agent',
        scope: 'cloud:inventory:read',
        actor: 'agent:cloud-agent@0.1.0',
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const { access_token } = (await exchange.json()) as { access_token: string };

    const refused = await failureOf(
      gatewayClient('code-forge').call(
        'code-forge',
        'repo_dependencies',
        { repo: 'acme/payments-service' },
        { delegatedToken: access_token },
      ),
    );
    // 401 at the door (audience not accepted), mapped policy_denied.
    expect(refused.errorClass).toBe('policy_denied');
    expect(refused.message).toBe('tool server code-forge refused the call (401)');
  });

  it('a tools token acting as an agent with no orchestrator chain is refused at the door', async () => {
    // The agent-secret + stolen-subject-token forge: acp:tools, agent actor,
    // but the chain has no svc:orchestrator hop. Refused before Cedar.
    const subjectToken = await getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
    const exchange = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: subjectToken,
        audience: 'acp:tools',
        actor: 'agent:cloud-agent@0.1.0',
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const { access_token } = (await exchange.json()) as { access_token: string };

    const refused = await failureOf(
      gatewayClient('code-forge').call(
        'code-forge',
        'repo_dependencies',
        { repo: 'acme/payments-service' },
        { delegatedToken: access_token },
      ),
    );
    expect(refused.errorClass).toBe('policy_denied');
    expect(refused.message).toBe('tool server code-forge refused the call (401)');
  });

  it('Cedar denies an agent calling a tool outside its manifest scopes — before the upstream', async () => {
    // A two-hop platform-role forge that DOES authenticate: svc-ci builds a
    // full chain (actor svc:orchestrator, then actor agent:cloud-agent) on an
    // acp:tools token, so the orchestrator-chain check passes. This is a
    // trusted-infra tier concern (a platform client can fabricate a chain) —
    // Cedar is the backstop: no permit accepts cloud scopes at code-forge, so
    // the denial lands before the upstream is ever contacted.
    const subjectToken = await getToken('cli-jane', 'jane-dev-secret', 'acp:gateway');
    const hop1 = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: subjectToken,
        audience: 'acp:orchestrator',
        actor: 'svc:orchestrator',
      }),
    });
    expect(hop1.status, await hop1.clone().text()).toBe(200);
    const hop1Token = ((await hop1.json()) as { access_token: string }).access_token;

    const hop2 = await fetch(`${TOKEN_URL}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'svc-ci',
        client_secret: 'ci-dev-secret',
        subject_token: hop1Token,
        audience: 'acp:tools',
        scope: 'cloud:inventory:read',
        actor: 'agent:cloud-agent@0.1.0',
      }),
    });
    expect(hop2.status, await hop2.clone().text()).toBe(200);
    const { access_token } = (await hop2.json()) as { access_token: string };

    const taskId = randomUUID();
    const denial = await failureOf(
      gatewayClient('code-forge').call(
        'code-forge',
        'repo_dependencies',
        { repo: 'acme/payments-service' },
        { delegatedToken: access_token, taskId },
      ),
    );
    expect(denial.errorClass).toBe('policy_denied');
    expect(denial.message).toContain('Cedar decision: deny');
    expect(denial.message).toContain('tool:code-forge:repo_dependencies');

    const events = await waitForAudit(taskId, (all) =>
      all.some((e) => e.event_type === 'tool.called'),
    );
    const denied = events.find((e) => e.event_type === 'tool.called');
    expect(denied, 'no tool.called audit event for the denial').toBeDefined();
    expect(denied!.reason?.policy?.decision).toBe('deny');
    expect((denied!.details as { outcome?: string }).outcome).toBe('denied');
    expect(denied!.actor.principal).toBe('agent:cloud-agent@0.1.0');
  });

  let knowledgeToken: string;

  it('serves the governed corpus to an IDE-shaped user through MCP, audited at BOTH PEPs', async () => {
    // The corpus must exist; re-ingestion is lineage-deduped, so this is
    // idempotent across files in the suite.
    const ingestToken = await ciToken('acp:knowledge', 'knowledge:ingest');
    const ingest = await fetch(`${KNOWLEDGE_URL}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ingestToken}` },
      body: JSON.stringify({ source_id: 'policy-docs' }),
    });
    expect(ingest.status, await ingest.clone().text()).toBe(200);

    knowledgeToken = await janeToolsToken();
    const taskId = randomUUID();
    const response: ToolResponse = await gatewayClient('knowledge').call(
      'knowledge',
      'knowledge_search',
      { query: 'change freeze policy' },
      { delegatedToken: knowledgeToken, taskId },
    );

    const results = response.data.results as { citation: { doc_id: string } }[];
    expect(results.length).toBeGreaterThan(0);
    const changePolicy = response.provenance.find((p) => p.doc_id === 'policy/change-management');
    expect(changePolicy, 'provenance must cite the change management policy').toBeDefined();
    expect(changePolicy!.version).toBe('3.2.0');
    expect(changePolicy!.lineage_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7

    const events = await waitForAudit(
      taskId,
      (all) =>
        all.some((e) => e.event_type === 'tool.called') &&
        all.some((e) => e.event_type === 'retrieval.served'),
    );

    // Gateway PEP: tool.called as the user herself.
    const toolCalled = events.find((e) => e.event_type === 'tool.called');
    expect(toolCalled, 'no tool.called event').toBeDefined();
    expect(toolCalled!.actor.principal).toBe('user:jane.doe');
    expect(toolCalled!.actor.delegation_chain?.map((l) => l.sub)).toEqual(['user:jane.doe']);
    expect(toolCalled!.reason?.policy?.decision).toBe('allow');
    expect(toolCalled!.reason?.policy?.determining_policies).toContain(
      'allow-tool-knowledge-search',
    );
    expect((toolCalled!.details as { outcome?: string }).outcome).toBe('ok');

    // Inner knowledge PEP: retrieval.served with the CLEAN one-link chain.
    // This pins the token-service fix: the gateway's actor-preserving
    // exchange of a plain user token must not fabricate an act link — a
    // regression would record [user:jane.doe, user:jane.doe] here.
    const retrieval = events.find((e) => e.event_type === 'retrieval.served');
    expect(retrieval, 'no retrieval.served event').toBeDefined();
    expect(retrieval!.actor.principal).toBe('user:jane.doe');
    expect(retrieval!.actor.delegation_chain?.map((l) => l.sub)).toEqual(['user:jane.doe']);

    // The two events describe the same served documents.
    const toolLineage = new Set(toolCalled!.artifacts?.lineage_ids ?? []);
    const servedLineage = retrieval!.artifacts?.lineage_ids ?? [];
    expect(servedLineage.length).toBeGreaterThan(0);
    expect(servedLineage.some((id) => toolLineage.has(id))).toBe(true);
  });

  it('rate limits knowledge_search past the burst of 5 with an actionable retry', async () => {
    // Runs AFTER the IDE test on purpose: the (knowledge, knowledge_search,
    // acme) bucket is shared. Eight concurrent calls against burst 5 make
    // at least one refusal deterministic regardless of per-call latency
    // (sequential calls could refill as fast as they consume).
    const taskId = randomUUID();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        gatewayClient('knowledge').call(
          'knowledge',
          'knowledge_search',
          { query: 'change freeze policy' },
          { delegatedToken: knowledgeToken, taskId },
        ),
      ),
    );

    const successes = outcomes.filter((o) => o.status === 'fulfilled');
    const limited = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [o.reason as ToolError] : [],
    );
    expect(successes.length).toBeGreaterThan(0);
    expect(limited.length).toBeGreaterThan(0);
    for (const failure of limited) {
      expect(failure.errorClass).toBe('retryable');
      expect(failure.message).toContain('rate limited');
      expect(failure.details?.retry_after_s).toBeGreaterThanOrEqual(1);
    }

    // The successful calls also land retrieval.served events (no details)
    // under this task id — read outcome defensively.
    const outcomeOf = (e: AuditEvent) => (e.details as { outcome?: string } | undefined)?.outcome;
    const events = await waitForAudit(taskId, (all) =>
      all.some((e) => outcomeOf(e) === 'rate_limited'),
    );
    const rateLimited = events.filter(
      (e) => e.event_type === 'tool.called' && outcomeOf(e) === 'rate_limited',
    );
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(
      (rateLimited[0]!.details as { retry_after_s?: number }).retry_after_s,
    ).toBeGreaterThanOrEqual(1);
  });
});
