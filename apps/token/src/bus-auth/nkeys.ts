/**
 * Typed adapter over the `nkeys` surface re-exported by `nats` (which ships
 * it loosely typed). All the unsafe-any laundering for the auth-callout key
 * handling is isolated here so the rest of bus-auth stays strictly typed.
 */

import { nkeys } from 'nats';

/** ed25519 account keypair: signs minted user JWTs + authorization responses. */
export interface AccountKeyPair {
  getPublicKey(): string;
  sign(data: Uint8Array): Uint8Array;
}

/** Curve (x25519) keypair: seals/opens the auth request/response payloads. */
export interface CurveKeyPair {
  getPublicKey(): string;
  seal(data: Uint8Array, recipient: string): Uint8Array;
  open(data: Uint8Array, sender: string): Uint8Array;
}

interface NkeysApi {
  fromSeed(seed: Uint8Array): AccountKeyPair;
  fromCurveSeed(seed: Uint8Array): CurveKeyPair;
}

const api = nkeys as unknown as NkeysApi;

/** Reconstructs the issuer account keypair from its seed (SA…). */
export function accountFromSeed(seed: string): AccountKeyPair {
  return api.fromSeed(new TextEncoder().encode(seed));
}

/** Reconstructs the responder curve keypair from its seed (SX…). */
export function curveFromSeed(seed: string): CurveKeyPair {
  return api.fromCurveSeed(new TextEncoder().encode(seed));
}
