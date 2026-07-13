/**
 * Session Context Cache (Phase 4 item 4), end to end against the real platform.
 *
 * The cache is a SECURITY-sensitive optimization: it memoizes only the
 * post-authorization retrieval (embed + pgvector search) under a key derived
 * from the caller's VERIFIED effective permissions. This suite proves the
 * integration properties that matter for correctness and isolation:
 *
 *   1. same principal + same query twice  → the second is served from cache
 *      (retrieval.served details.cache: miss → hit), still re-authorized.
 *   2. permission change (narrower scope)  → a different key → no stale hit.
 *   3. cross-principal isolation           → principal B never reads A's entry.
 *   4. lineage change (corpus re-ingest)   → the entry is evicted → miss.
 *   5. kill-switch (fleet halt)            → the cache is bypassed entirely.
 *
 * This file sets ACP_SESSION_CACHE_ENABLED=true for its OWN platform instance;
 * the flag defaults OFF, so the other E2E files are unaffected.
 *
 * Prerequisites: `make dev`, `pnpm build`. Boots the platform itself.
 */
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import type { AuditEvent } from '@acp/protocol';
import { sha256Digest } from '@acp/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_URL,
  KNOWLEDGE_URL,
  REGISTRY_URL,
  TOKEN_URL,
  startPlatform,
  stopPlatform,
} from './support/platform.js';

const DB_URL = 'postgres://acp:acp-dev-password@localhost:5432/acp';
const LINEAGE_SOURCE = 'runbooks';

let platform: ChildProcess;

async function getToken(
  clientId: string,
  clientSecret: string,
  audience: string,
  scope?: string,
): Promise<string> {
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

const janeToken = (scope = 'knowledge:search:read') =>
  getToken('cli-jane', 'jane-dev-secret', 'acp:knowledge', scope);
const proberToken = () =>
  getToken('svc-prober', 'prober-dev-secret', 'acp:knowledge', 'knowledge:search:read');
const ciToken = (audience: string, scope: string) =>
  getToken('svc-ci', 'ci-dev-secret', audience, scope);
const adminToken = () => ciToken('acp:registry', 'registry:admin');

async function search(token: string, query: string, sourceId?: string): Promise<number> {
  const res = await fetch(`${KNOWLEDGE_URL}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, ...(sourceId === undefined ? {} : { source_id: sourceId }) }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.status;
}

async function ingest(sourceId: string): Promise<void> {
  const token = await ciToken('acp:knowledge', 'knowledge:ingest');
  const res = await fetch(`${KNOWLEDGE_URL}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ source_id: sourceId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function flipFleet(active: boolean): Promise<void> {
  const res = await fetch(`${REGISTRY_URL}/v1/killswitch/fleet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminToken()}` },
    body: JSON.stringify({ active, reason: 'session-cache E2E fleet bypass' }),
  });
  expect(res.status, await res.clone().text()).toBe(202);
}

/** The ordered details.cache markers of retrieval.served events for a given query. */
async function cacheMarkers(query: string, tenant = 'acme'): Promise<(string | undefined)[]> {
  const digest = sha256Digest(query);
  const token = await ciToken('acp:audit', 'audit:read');
  const params = new URLSearchParams({ tenant, event_type: 'retrieval.served', limit: '1000' });
  const res = await fetch(`${AUDIT_URL}/v1/events?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const events = ((await res.json()) as { events: AuditEvent[] }).events;
  return events
    .filter((e) => e.action.inputs_digest === digest)
    .map((e) => (e.details as { cache?: string } | undefined)?.cache);
}

/** Polls until `query` has at least `n` retrieval.served events, returning their markers. */
async function waitForMarkers(
  query: string,
  n: number,
  tenant = 'acme',
): Promise<(string | undefined)[]> {
  for (let i = 0; i < 30; i++) {
    const markers = await cacheMarkers(query, tenant);
    if (markers.length >= n) return markers;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return cacheMarkers(query, tenant);
}

beforeAll(async () => {
  // Enable the cache for THIS platform instance only (defaults OFF elsewhere).
  process.env.ACP_SESSION_CACHE_ENABLED = 'true';
  process.env.ACP_SESSION_CACHE_TTL_MS = '60000';
  platform = await startPlatform();

  // Ingest the corpus so retrieval returns real chunks. Idempotent across a
  // shared CI postgres (unchanged chunks are skipped).
  for (const sourceId of ['policy-docs', 'eng-standards', LINEAGE_SOURCE]) {
    await ingest(sourceId);
  }
}, 300_000);

afterAll(async () => {
  // Never leave the fleet halted for the next file.
  try {
    await flipFleet(false);
  } catch {
    /* platform may already be gone */
  }
  stopPlatform(platform);
});

describe('session context cache', () => {
  it('serves a repeated identical query from cache (miss → hit)', async () => {
    const query = 'session cache e2e repeated retrieval probe alpha';
    await search(await janeToken(), query);
    await search(await janeToken(), query);
    const markers = await waitForMarkers(query, 2);
    expect(markers).toEqual(['miss', 'hit']);
  });

  it('does not serve a broader entry to a narrower permission (different key)', async () => {
    const query = 'session cache e2e narrowing probe gamma';
    // Broad token: two scopes. Narrow token: one scope. Same query, same
    // principal — but a different effective permission → a different key.
    await search(await janeToken('knowledge:search:read task:submit'), query);
    await search(await janeToken('knowledge:search:read'), query);
    const markers = await waitForMarkers(query, 2);
    // The narrower call must NOT hit the broader entry.
    expect(markers).toEqual(['miss', 'miss']);
  });

  it('isolates principals: B never reads A cached entry', async () => {
    const query = 'session cache e2e isolation probe beta';
    await search(await janeToken(), query); // A: miss
    await search(await janeToken(), query); // A: hit (same key)
    await search(await proberToken(), query); // B: miss (different principal → different key)
    const markers = await waitForMarkers(query, 3);
    expect(markers).toEqual(['miss', 'hit', 'miss']);
  });

  it('evicts a cached entry when its source lineage changes (re-ingest)', async () => {
    const query = 'session cache e2e lineage probe epsilon';
    const token = () => janeToken();
    await search(await token(), query, LINEAGE_SOURCE); // miss + write (captures gen)
    await search(await token(), query, LINEAGE_SOURCE); // hit
    expect(await waitForMarkers(query, 2)).toEqual(['miss', 'hit']);

    // Force a real corpus mutation: delete this source's chunks and re-ingest,
    // which emits corpus.mutation → the invalidator bumps gen.acme.<source>.
    const pool = new pg.Pool({ connectionString: DB_URL });
    try {
      await pool.query(`DELETE FROM knowledge_chunks WHERE tenant='acme' AND source_id=$1`, [
        LINEAGE_SOURCE,
      ]);
    } finally {
      await pool.end();
    }
    await ingest(LINEAGE_SOURCE);
    // Give the invalidator + generation watcher time to propagate the bump.
    await new Promise((r) => setTimeout(r, 8000));

    await search(await token(), query, LINEAGE_SOURCE); // stale → miss (evicted)
    const markers = await waitForMarkers(query, 3);
    expect(markers).toHaveLength(3);
    expect(markers[2]).toBe('miss');
  }, 60_000);

  it('bypasses the cache under a fleet halt (no cache marker), and recovers', async () => {
    const query = 'session cache e2e killswitch bypass probe delta';
    await search(await janeToken(), query); // primes an entry
    expect(await waitForMarkers(query, 1)).toEqual(['miss']);

    await flipFleet(true);
    try {
      // Direct retrieval still works, but the cache is bypassed → no details.cache.
      await search(await janeToken(), query);
      const markers = await waitForMarkers(query, 2);
      expect(markers).toHaveLength(2);
      expect(markers[1]).toBeUndefined(); // bypassed: no cache marker
    } finally {
      await flipFleet(false);
    }
  }, 60_000);
});
