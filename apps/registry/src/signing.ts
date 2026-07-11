import type { AgentCard, AgentManifest } from '@acp/protocol';
import {
  CompactSign,
  compactVerify,
  createLocalJWKSet,
  type JSONWebKeySet,
  type CryptoKey,
} from 'jose';

/**
 * Deterministic JSON: object keys sorted recursively. Signature payloads
 * must not depend on property insertion order, or verification breaks the
 * moment a card round-trips through a different runtime.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The signed identity content: what the agent IS, not its mutable lifecycle. */
export function cardSigningPayload(
  manifest: AgentManifest,
  version: string,
  registeredAt: string,
): Uint8Array {
  return new TextEncoder().encode(
    stableStringify({ manifest, version, registered_at: registeredAt }),
  );
}

export async function signCard(
  key: { kid: string; privateKey: CryptoKey },
  manifest: AgentManifest,
  version: string,
  registeredAt: string,
): Promise<string> {
  return new CompactSign(cardSigningPayload(manifest, version, registeredAt))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .sign(key.privateKey);
}

/** Consumers verify provenance: the signature must match the card's own identity content. */
export async function verifyCard(card: AgentCard, jwks: JSONWebKeySet): Promise<boolean> {
  try {
    const { payload } = await compactVerify(card.card_signature, createLocalJWKSet(jwks));
    const expected = cardSigningPayload(card.manifest, card.version, card.registered_at);
    return payload.length === expected.length && payload.every((byte, i) => byte === expected[i]);
  } catch {
    return false;
  }
}
