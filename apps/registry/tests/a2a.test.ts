import type { AgentCard, AgentManifest } from '@acp/protocol';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { a2aSigningPayload, signA2ACard, toA2ACard, verifyA2ACard } from '../src/a2a.js';

/**
 * A deliberately leak-rich internal card: every field the allowlist must
 * NEVER export is present with a distinctive marker value, so the projection
 * tests can assert absence by marker, not by field name alone.
 */
const manifest: AgentManifest = {
  id: 'external-echo',
  name: 'External Echo',
  description: 'Echoes structured input via a governed external remote.',
  owner: 'team-secret-internal-owner',
  capabilities: [
    {
      name: 'external.echo',
      description: 'Echo structured input.',
      risk: 'R0',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      examples: [
        { input: { message: 'hello' } },
        { input: { message: 'ping' } },
        { input: { message: 'echo' } },
      ],
    },
    {
      name: 'external.submit',
      description: 'A write with saga wiring that must stay internal.',
      risk: 'R2',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      examples: [{ input: { a: 1 } }, { input: { a: 2 } }, { input: { a: 3 } }],
      compensator: 'external.withdraw',
    },
    {
      name: 'external.withdraw',
      description: 'Compensator for external.submit.',
      risk: 'R2',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      examples: [{ input: { b: 1 } }, { input: { b: 2 } }, { input: { b: 3 } }],
      irreversible: true,
    },
  ],
  tools: [{ server: 'secret-sor-server', scopes: ['secretsys:records:write'] }],
  models: { allowed: ['secret-model-tier'] },
  data_classification: 'restricted',
  sla: { p95_latency_s: 30 },
};

const card: AgentCard = {
  manifest,
  version: '0.1.0',
  lifecycle_state: 'active',
  registered_at: '2026-07-12T00:00:00.000Z',
  updated_at: '2026-07-12T00:00:00.000Z',
  state_reason: 'secret-state-reason',
  card_signature: 'internal-jws-that-must-not-ship-externally',
  eval_baseline: {
    schema: 'acp-eval-baseline/v1',
    agent_id: 'external-echo',
    agent_version: '0.1.0',
    metrics: { pass_rate: 1, citation_precision: 1, abstention_accuracy: 1 },
    suite: { digest: 'sha256:baseline-digest-secret', case_count: 3 },
    harness: 'acp-agent-sdk-ts@0.1.0',
    recorded_at: '2026-07-12T00:00:00.000Z',
  },
};

const opts = {
  edgeBaseUrl: 'http://localhost:7100',
  providerOrg: 'Agentic Control Plane (dev)',
  tokenUrl: 'http://localhost:7101',
};

let key: { kid: string; privateKey: CryptoKey };
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  key = { kid, privateKey: pair.privateKey };
  jwks = { keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }] };
});

describe('toA2ACard projection (strict allowlist)', () => {
  const projected = toA2ACard(card, opts);
  const wire = JSON.stringify(projected);

  it('exports the public identity and skills', () => {
    expect(projected.protocolVersion).toBe('1.0');
    expect(projected.name).toBe('External Echo');
    expect(projected.version).toBe('0.1.0');
    expect(projected.url).toBe('http://localhost:7100/v1/a2a/agents/external-echo');
    expect(projected.preferredTransport).toBe('JSONRPC');
    expect(projected.skills.map((s) => s.id)).toEqual([
      'external.echo',
      'external.submit',
      'external.withdraw',
    ]);
    expect(projected.skills[0]?.tags).toEqual(['R0']);
    expect(projected.skills[0]?.examples).toContain('{"message":"hello"}');
    expect(projected.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
  });

  it('advertises only the external security scheme, not internal scopes', () => {
    expect(projected.security).toEqual([{ 'platform-oauth2': ['task:submit'] }]);
    expect(wire).not.toContain('secretsys:records:write');
  });

  it('never exports tool bindings, SoR topology, or internal scope vocabulary', () => {
    expect(wire).not.toContain('secret-sor-server');
    expect(wire).not.toContain('"tools"');
  });

  it('never exports models, data classification, sla, or tenant', () => {
    expect(wire).not.toContain('secret-model-tier');
    expect(wire).not.toContain('data_classification');
    expect(wire).not.toContain('restricted');
    expect(wire).not.toContain('"sla"');
    expect(wire).not.toContain('"tenant"');
  });

  it('never exports saga wiring (compensator/irreversible)', () => {
    expect(wire).not.toContain('compensator');
    expect(wire).not.toContain('irreversible');
  });

  it('never exports eval baseline, lifecycle, state reason, or the internal signature', () => {
    expect(wire).not.toContain('eval_baseline');
    expect(wire).not.toContain('baseline-digest-secret');
    expect(wire).not.toContain('lifecycle_state');
    expect(wire).not.toContain('secret-state-reason');
    expect(wire).not.toContain('internal-jws-that-must-not-ship-externally');
  });

  it('replaces the owning team with the platform org constant', () => {
    expect(projected.provider?.organization).toBe('Agentic Control Plane (dev)');
    expect(wire).not.toContain('team-secret-internal-owner');
  });

  it('is pure: no signature until signA2ACard runs', () => {
    expect(projected.signatures).toBeUndefined();
  });
});

describe('detached JWS signing', () => {
  it('signs and verifies against the JWKS', async () => {
    const signed = await signA2ACard(key, toA2ACard(card, opts));
    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures?.[0]?.protected).toBeTruthy();
    await expect(verifyA2ACard(signed, jwks)).resolves.toBe(true);
  });

  it('rejects a tampered card', async () => {
    const signed = await signA2ACard(key, toA2ACard(card, opts));
    const tampered = { ...signed, description: 'tampered description' };
    await expect(verifyA2ACard(tampered, jwks)).resolves.toBe(false);
  });

  it('rejects a card signed by a different key', async () => {
    const otherPair = await generateKeyPair('EdDSA', { extractable: true });
    const otherJwk = await exportJWK(otherPair.publicKey);
    const otherKid = await calculateJwkThumbprint(otherJwk);
    const signed = await signA2ACard(
      { kid: otherKid, privateKey: otherPair.privateKey },
      toA2ACard(card, opts),
    );
    await expect(verifyA2ACard(signed, jwks)).resolves.toBe(false);
  });

  it('rejects an unsigned card', async () => {
    await expect(verifyA2ACard(toA2ACard(card, opts), jwks)).resolves.toBe(false);
  });

  it('signing payload excludes the signatures themselves', async () => {
    const unsigned = toA2ACard(card, opts);
    const signed = await signA2ACard(key, unsigned);
    expect(a2aSigningPayload(signed)).toEqual(a2aSigningPayload(unsigned));
  });
});
