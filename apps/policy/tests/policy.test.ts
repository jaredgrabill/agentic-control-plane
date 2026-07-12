import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '@acp/protocol';
import { JwtVerifier, createLogger } from '@acp/service-kit';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPolicyApp, POLICY_AUDIENCE } from '../src/app.js';
import { loadBundle } from '../src/bundle.js';
import { CedarPdp, type AuthzRequest } from '../src/pdp.js';

const ISSUER = 'https://token.test.local';
const BUNDLE_DIR = join(import.meta.dirname, '..', '..', '..', 'policies');

interface GoldenCase {
  name: string;
  expect: 'allow' | 'deny';
  determined_by?: string;
  request: AuthzRequest;
}
const golden = JSON.parse(readFileSync(join(BUNDLE_DIR, 'tests', 'cases.json'), 'utf8')) as {
  cases: GoldenCase[];
};

const logger = createLogger('policy-test');
const bundle = loadBundle(BUNDLE_DIR);
const pdp = new CedarPdp(bundle, logger);

describe('golden policy suite (the active bundle)', () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const decision = pdp.authorize(c.request);
      expect(decision.decision).toBe(c.expect);
      expect(decision.bundle_version).toBe(bundle.version);
      if (c.determined_by !== undefined) {
        expect(decision.determining_policies).toContain(c.determined_by);
      }
      if (c.expect === 'deny') {
        // Default deny: denials come from the absence of a permit, never
        // from a forbid we haven't written yet.
        expect(decision.determining_policies).toEqual([]);
      }
    });
  }

  it('every policy in the bundle is exercised by at least one allow case (no untested territory)', () => {
    const exercised = new Set(
      golden.cases.filter((c) => c.expect === 'allow').map((c) => c.determined_by),
    );
    for (const id of pdp.policyIds) {
      expect(exercised, `policy ${id} has no allow case in policies/tests/cases.json`).toContain(
        id,
      );
    }
  });

  it('has both allow and deny coverage', () => {
    expect(golden.cases.some((c) => c.expect === 'allow')).toBe(true);
    expect(golden.cases.some((c) => c.expect === 'deny')).toBe(true);
  });
});

describe('bundle loading', () => {
  it('derives a content-addressed version', () => {
    expect(bundle.version).toMatch(/^2026\.07\+[0-9a-f]{12}$/);
  });

  it('rejects directories with no policies', () => {
    expect(() => loadBundle(join(import.meta.dirname))).toThrow(/no .cedar files/);
  });

  it('rejects anonymous, misnamed, and duplicate policies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-bundle-'));
    const policy = (id: string) => `@id("${id}")\npermit (principal, action, resource);\n`;

    writeFileSync(join(dir, 'anon.cedar'), 'permit (principal, action, resource);');
    expect(() => loadBundle(dir)).toThrow(/@id/);

    writeFileSync(join(dir, 'anon.cedar'), policy('something-else'));
    expect(() => loadBundle(dir)).toThrow(/must match the filename/);

    writeFileSync(join(dir, 'anon.cedar'), policy('anon'));
    const loaded = loadBundle(dir);
    // No VERSION file → dev prefix.
    expect(loaded.version).toMatch(/^dev\+[0-9a-f]{12}$/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fail-closed evaluation', () => {
  it('denies when the policy text does not evaluate', () => {
    const broken = new CedarPdp(
      { policies: { broken: 'this is not cedar at all' }, version: 'test+000000000000' },
      logger,
    );
    const decision = broken.authorize(golden.cases[0]!.request);
    expect(decision.decision).toBe('deny');
    expect(decision.determining_policies).toEqual([]);
  });
});

describe('HTTP surface', () => {
  let app: FastifyInstance;
  let tokenKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let tokenJwk: JWK;
  const auditEvents: AuditEvent[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA');
    tokenKey = pair.privateKey;
    tokenJwk = await exportJWK(pair.publicKey);
    app = buildPolicyApp({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...tokenJwk, alg: 'EdDSA' }] } }, ISSUER),
      pdp,
      audit: {
        publish: (e) => {
          auditEvents.push(e);
          return Promise.resolve();
        },
      },
      logger,
    });
  });

  beforeEach(() => {
    auditEvents.length = 0;
  });

  async function makeToken(scope = 'policy:decide'): Promise<string> {
    return new SignJWT({ sub: 'svc:knowledge', tenant: 'platform', roles: ['platform'], scope })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(POLICY_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(tokenKey);
  }

  const allowCase = golden.cases.find((c) => c.expect === 'allow')!;

  it('authorizes over HTTP and emits a policy.decision audit event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: { authorization: `Bearer ${await makeToken()}` },
      payload: {
        ...allowCase.request,
        reason: { task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40', tenant: 'acme' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ decision: string; determining_policies: string[] }>();
    expect(body.decision).toBe('allow');

    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.event_type).toBe('policy.decision');
    expect(event.tenant).toBe('acme');
    expect(event.reason?.policy?.decision).toBe('allow');
    expect(event.reason?.policy?.bundle_version).toBe(bundle.version);
    expect(event.reason?.task_id).toBe('0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40');
  });

  it('requires authN and the policy:decide scope', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      payload: allowCase.request,
    });
    expect(anon.statusCode).toBe(401);

    const wrongScope = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: { authorization: `Bearer ${await makeToken('registry:read')}` },
      payload: allowCase.request,
    });
    expect(wrongScope.statusCode).toBe(403);
  });

  it('rejects malformed authorization requests', async () => {
    for (const payload of [
      {},
      { principal: { type: 'Wizard', id: 'x' }, action: 'a', resource: allowCase.request.resource },
      { principal: allowCase.request.principal, resource: allowCase.request.resource },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/authorize',
        headers: { authorization: `Bearer ${await makeToken()}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('keeps deciding when the audit sink fails (alarm-and-continue)', async () => {
    const failing = buildPolicyApp({
      verifier: new JwtVerifier({ jwks: { keys: [{ ...tokenJwk, alg: 'EdDSA' }] } }, ISSUER),
      pdp,
      audit: { publish: () => Promise.reject(new Error('stream down')) },
      logger,
    });
    const res = await failing.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: { authorization: `Bearer ${await makeToken()}` },
      payload: allowCase.request,
    });
    expect(res.statusCode).toBe(200);
  });

  it('serves the bundle version for PEP stamping', async () => {
    const res = await app.inject({
      url: '/v1/bundle',
      headers: { authorization: `Bearer ${await makeToken()}` },
    });
    expect(res.json<{ version: string; policy_ids: string[] }>().policy_ids).toContain(
      'allow-knowledge-read',
    );
  });
});
