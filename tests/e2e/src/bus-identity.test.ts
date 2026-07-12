/**
 * Phase 3 item 0c: NATS auth callout + session-scoped bus identities.
 *
 * The dev stack now mints per-session bus identities from platform JWTs
 * (aud acp:bus) instead of static tenant users. These are the trust-boundary
 * security-negative cases (design section 7): a legit bus session, the exact
 * publish/subscribe template it is confined to, cross-audience refusal both
 * directions, and the broker-time denylist refusing a fresh bus mint.
 *
 * All bus tests use the cloud-agent identity, which runs no bus worker in the
 * dev stack (noRetriever) — so denylisting it never disturbs the live
 * knowledge-agent session sharing this platform instance.
 *
 * Requires the NATS container to be RECREATED after the conf change:
 *   docker compose -f deploy/compose/docker-compose.yml -p acp-dev up -d
 */

import { randomUUID } from 'node:crypto';
import { type ChildProcess } from 'node:child_process';
import type { AuditEvent } from '@acp/protocol';
import { KillSwitchControl } from '@acp/service-kit';
import { connect, Events, tokenAuthenticator, type NatsConnection } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_URL, TOKEN_URL, startPlatform, stopPlatform } from './support/platform.js';

const NATS_URL = 'nats://localhost:4222';
const CLOUD_AGENT = 'agent:cloud-agent@0.1.0';

let platform: ChildProcess | undefined;
/** A control-plane connection (platform bypass user) for the kill switch. */
let control: NatsConnection | undefined;

async function getToken(
  clientId: string,
  clientSecret: string,
  audience: string,
  scope?: string,
): Promise<{ status: number; token?: string; body: string }> {
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

async function busToken(clientId: string, secret: string): Promise<string> {
  const res = await getToken(clientId, secret, 'acp:bus');
  expect(res.status, res.body).toBe(200);
  return res.token!;
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

async function ciToken(audience: string, scope: string): Promise<string> {
  const res = await getToken('svc-ci', 'ci-dev-secret', audience, scope);
  expect(res.status, res.body).toBe(200);
  return res.token!;
}

async function auditEvents(taskFilter: string): Promise<AuditEvent[]> {
  const token = await ciToken('acp:audit', 'audit:read');
  const res = await fetch(`${AUDIT_URL}/v1/events?tenant=acme&event_type=token.denied`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const events = ((await res.json()) as { events: AuditEvent[] }).events;
  return events.filter((e) => JSON.stringify(e.details ?? {}).includes(taskFilter));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  platform = await startPlatform();
  // Platform bypass user (in auth_users) — used only to drive the kill switch.
  control = await connect({ servers: NATS_URL, user: 'token', pass: 'token-dev-password' });
}, 300_000);

afterAll(async () => {
  await control?.close();
  stopPlatform(platform);
});

describe('phase 3 bus identity (auth callout)', () => {
  it('an agent mints an acp:bus token and connects through the callout', async () => {
    const token = await busToken('agent-cloud-agent', 'agent-cloud-dev-secret');
    const nc = await busConnect(token);
    // A live connection: an allowed publish (telemetry) flushes without error.
    nc.publish('acp.acme.telemetry.bus-identity-test', new TextEncoder().encode('{}'));
    await nc.flush();
    await nc.close();
  });

  it('an agent session cannot publish audit — it may not attest task.completed (B1)', async () => {
    // Agents carry NO audit publish grant: the within-tenant budget cap trusts
    // that only the platform attests task.completed. Even the agent's OWN
    // tenant audit subject is refused by the account boundary.
    const token = await busToken('agent-cloud-agent', 'agent-cloud-dev-secret');
    const nc = await busConnect(token);
    const errors: string[] = [];
    void (async () => {
      for await (const s of nc.status()) {
        if (s.type === Events.Error) errors.push(JSON.stringify(s));
      }
    })();
    nc.publish('acp.acme.audit.task.completed', new TextEncoder().encode('{}'));
    await nc.flush();
    await sleep(750);
    const joined = errors.join(' ');
    expect(joined).toMatch(/PERMISSIONS_VIOLATION/i);
    expect(joined).toContain('acp.acme.audit.task.completed');
    await nc.close();
  });

  it('confines the session to its tenant template — an out-of-tenant publish is a violation', async () => {
    const token = await busToken('agent-cloud-agent', 'agent-cloud-dev-secret');
    const nc = await busConnect(token);
    const errors: string[] = [];
    void (async () => {
      for await (const s of nc.status()) {
        if (s.type === Events.Error) errors.push(JSON.stringify(s));
      }
    })();
    // Another tenant's subject and a platform-internal service subject are
    // both outside the template — the server refuses them.
    nc.publish('acp.globex.audit.x', new TextEncoder().encode('{}'));
    nc.publish('acp.platform.svc.orchestrator.x', new TextEncoder().encode('{}'));
    await nc.flush();
    await sleep(750);
    const joined = errors.join(' ');
    expect(joined).toMatch(/PERMISSIONS_VIOLATION/i);
    // The server named the exact forbidden subjects it refused.
    expect(joined).toContain('acp.globex.audit.x');
    expect(joined).toContain('acp.platform.svc.orchestrator.x');
    await nc.close();
  });

  it('refuses an acp:tools token at the bus (cross-audience, both directions)', async () => {
    const tools = await getToken('agent-cloud-agent', 'agent-cloud-dev-secret', 'acp:tools');
    expect(tools.status).toBe(200);
    await expect(busConnect(tools.token!)).rejects.toThrow();
  });

  it('refuses a non-agent (user) acp:bus token — the role gate', async () => {
    // cli-jane can MINT an acp:bus token, but the callout refuses a
    // tenant-user role at connection time.
    const userBus = await busToken('cli-jane', 'jane-dev-secret');
    await expect(busConnect(userBus)).rejects.toThrow();
  });

  it('a denylisted agent principal cannot mint a fresh acp:bus token (token.denied audited), then recovers', async () => {
    if (control === undefined) throw new Error('no control connection');
    const marker = randomUUID();
    const ctrl = await KillSwitchControl.open(control);
    await ctrl.denyPrincipal(CLOUD_AGENT, `e2e drill ${marker}`, 'svc:agent-ci');
    // Give the token service's in-memory watcher a moment to see the KV write.
    await sleep(1_000);

    const denied = await getToken('agent-cloud-agent', 'agent-cloud-dev-secret', 'acp:bus');
    expect(denied.status).toBe(403);

    // token.denied audit records the refusal with the principal_denylist reason.
    let events: AuditEvent[] = [];
    for (let i = 0; i < 15 && events.length === 0; i++) {
      events = (await auditEvents(CLOUD_AGENT)).filter(
        (e) => (e.details as { reason?: string }).reason === 'principal_denylist',
      );
      if (events.length === 0) await sleep(1_000);
    }
    expect(events.length, 'no token.denied audit for the denylisted principal').toBeGreaterThan(0);

    // Reinstate → minting works again within the propagation window.
    await ctrl.allowPrincipal(CLOUD_AGENT);
    let recovered = 0;
    for (let i = 0; i < 15; i++) {
      const res = await getToken('agent-cloud-agent', 'agent-cloud-dev-secret', 'acp:bus');
      if (res.status === 200) {
        recovered = 200;
        break;
      }
      await sleep(1_000);
    }
    expect(recovered).toBe(200);
  });
});
