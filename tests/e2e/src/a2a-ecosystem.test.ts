/**
 * Phase 4 item 3: A2A edge + ecosystem, end to end against the real stack.
 *
 *  1. Governed proxy: the external-echo proxy agent forwards external.echo to
 *     the mock A2A remote (7305) with its OWN credential — the orchestrator PEP
 *     gates it exactly like a native agent. The mock rejects any bearer other
 *     than the adapter credential, so a completed task IS the proof the
 *     platform's delegated token never egressed. (The PEP is unchanged for a
 *     proxy agent, so the kill-switch deny-on-dispatch path is not re-proven
 *     here — killswitch-audit.test.ts covers the switch tiers end to end.)
 *  2. A2A input-required maps to a needs_input step outcome — NEVER an approval
 *     grant (no approval.* audit for the task).
 *  3. Card export: the public /.well-known edge serves a signed card with NO
 *     internal scopes / tools / SoR / tenant, verifiable against the registry
 *     JWKS. A non-exposed agent 404s.
 *  4. Paved road: scaffold → shadow under SLO, with the git-diff
 *     zero-platform-changes invariant.
 *
 * Deterministic (zero LLM calls). Follows the netsec-agent E2E shape.
 */

import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuditEvent, TaskResult } from '@acp/protocol';
import { stableStringify } from '@acp/service-kit';
import { createLocalJWKSet, flattenedVerify, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  GATEWAY_URL,
  REGISTRY_URL,
  TOKEN_URL,
  registerAndActivate,
  repoRoot,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

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

async function submitTask(text: string, capability: string, context: Record<string, unknown>) {
  const res = await fetch(`${GATEWAY_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await janeToken()}` },
    body: JSON.stringify({ text, capability, context }),
  });
  const body = (await res.json()) as { task_id: string };
  return { task_id: body.task_id, status: res.status };
}

async function waitForTask(
  taskId: string,
  timeoutMs = 90_000,
): Promise<{ status: string; result: TaskResult | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${GATEWAY_URL}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${await janeToken()}` },
    });
    const body = (await res.json()) as { status: string; result: TaskResult | null };
    if (body.status === 'completed' || body.status === 'failed') return body;
    if (Date.now() > deadline)
      throw new Error(`task ${taskId} still ${body.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function auditEvents(taskId: string, tenant = 'acme'): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=${tenant}&task_id=${taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

/** Reconstructs the detached-JWS payload and verifies it against the registry JWKS. */
async function verifyCardSignature(
  card: Record<string, unknown>,
  jwks: JSONWebKeySet,
): Promise<boolean> {
  const sig = (card.signatures as { protected: string; signature: string }[] | undefined)?.[0];
  if (sig === undefined) return false;
  const { signatures: _sig, ...unsigned } = card;
  try {
    await flattenedVerify(
      {
        protected: sig.protected,
        signature: sig.signature,
        payload: new TextEncoder().encode(stableStringify(unsigned)),
      },
      createLocalJWKSet(jwks),
    );
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  platform = await startPlatform();
}, 300_000);

afterAll(() => {
  stopPlatform(platform);
});

describe('phase 4 a2a edge + ecosystem', () => {
  it('registers and activates the external-echo proxy agent', async () => {
    const writeToken = await ciToken('acp:registry', 'registry:write registry:admin');
    await registerAndActivate(
      join(repoRoot, 'agents', 'external-echo', 'manifest.yaml'),
      'external-echo',
      writeToken,
      'phase 4 a2a proxy promotion',
    );
  });

  it('runs a governed proxy round-trip; the delegated token never reaches the remote', async () => {
    const submitted = await submitTask('echo this', 'external.echo', {
      text: 'hello from the platform',
      directive: 'echo',
    });
    expect(submitted.status).toBe(202);
    const done = await waitForTask(submitted.task_id);

    // The mock remote accepts ONLY the adapter's own credential. A completed
    // task therefore proves the adapter authenticated with ACP_PROXY_CREDENTIAL
    // and NOT the broker delegated token (which would have 401'd).
    expect(done.result?.status, JSON.stringify(done.result?.error ?? {})).toBe('completed');
    expect(done.result?.answer?.text).toContain('echo: hello from the platform');
    // Remote citations are never first-party — the answer carries none.
    expect(done.result?.answer?.citations).toEqual([]);
    // No forged first-party lineage leaked through.
    expect(JSON.stringify(done.result)).not.toContain('remote-forged');

    const events = await auditEvents(submitted.task_id);
    expect(events.some((e) => e.event_type === 'step.dispatched')).toBe(true);
    expect(events.some((e) => e.event_type === 'step.completed')).toBe(true);
    // The PEP gated the proxy like a native agent: a broker delegation was minted.
    expect(events.some((e) => e.event_type === 'token.brokered')).toBe(true);
  });

  it('maps A2A input-required to needs_input, never an approval grant', async () => {
    const submitted = await submitTask('need more', 'external.echo', {
      text: 'incomplete request',
      directive: 'input-required',
    });
    expect(submitted.status).toBe(202);
    const done = await waitForTask(submitted.task_id);
    // The workflow completes, but the TASK OUTCOME is a failed step with the
    // needs_input class — the A2A input-required gap, never an approval grant.
    expect(done.result?.status).toBe('failed');
    expect(done.result?.error?.class).toBe('needs_input');

    // The gap must NOT touch the approval state machine.
    const events = await auditEvents(submitted.task_id);
    expect(events.some((e) => e.event_type.startsWith('approval.'))).toBe(false);
  });

  it('serves a signed public A2A card with no internal leaks', async () => {
    // Unauthenticated public edge (no Authorization header).
    const index = await fetch(`${GATEWAY_URL}/.well-known/agent.json`);
    expect(index.status).toBe(200);
    const indexBody = (await index.json()) as { agents: { agent_id: string }[] };
    expect(indexBody.agents.some((a) => a.agent_id === 'external-echo')).toBe(true);

    const cardRes = await fetch(
      `${GATEWAY_URL}/v1/a2a/agents/external-echo/.well-known/agent.json`,
    );
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as Record<string, unknown>;
    expect(card.protocolVersion).toBe('1.0');
    expect(card.name).toBe('External Echo Proxy Agent');

    // Signature verifies against the registry's public JWKS.
    const jwksRes = await fetch(`${REGISTRY_URL}/.well-known/jwks.json`);
    const jwks = (await jwksRes.json()) as JSONWebKeySet;
    expect(await verifyCardSignature(card, jwks)).toBe(true);

    // Leak-prevention: NONE of the internal topology/governance vocabulary.
    const wire = JSON.stringify(card);
    for (const leak of [
      'tools',
      'data_classification',
      'lifecycle_state',
      'tenant',
      'eval_baseline',
      'compensator',
      'models',
    ]) {
      expect(wire, `card must not expose ${leak}`).not.toContain(`"${leak}"`);
    }
    // The exported security scheme is the EXTERNAL edge scope, not internal scopes.
    expect(wire).not.toContain('registry:');
    expect(wire).not.toContain('netsec:');
  });

  it('404s a non-exposed agent at the public edge', async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/a2a/agents/change-agent/.well-known/agent.json`);
    expect(res.status).toBe(404);
  });

  it('paves the road: scaffold to shadow under SLO with zero platform changes', async () => {
    const scriptUrl = pathToFileURL(join(repoRoot, 'scripts', 'paved-road-slo.mjs')).href;
    const { runPavedRoadSlo } = (await import(scriptUrl)) as {
      runPavedRoadSlo: (
        o: Record<string, unknown>,
      ) => Promise<{ ok: boolean; elapsedMs: number; sloMs: number }>;
    };
    const result = await runPavedRoadSlo({ repoRoot, sloMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeLessThan(result.sloMs);
  });
});
