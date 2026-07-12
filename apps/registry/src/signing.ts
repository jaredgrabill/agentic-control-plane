import type { AgentCard, AgentManifest } from '@acp/protocol';
// stableStringify now lives in @acp/service-kit (three consumers: this card
// signature, the approval subject digest, audit canonicalization). Re-exported
// so existing importers of ./signing keep working.
import { stableStringify } from '@acp/service-kit';
import {
  CompactSign,
  compactVerify,
  createLocalJWKSet,
  type JSONWebKeySet,
  type CryptoKey,
} from 'jose';

export { stableStringify } from '@acp/service-kit';

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
