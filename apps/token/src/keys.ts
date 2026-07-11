import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  type JWK,
  type JSONWebKeySet,
  type CryptoKey,
} from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export interface KeyStore {
  current: SigningKey;
  /** Rotation window: verifiers accept tokens signed by the previous key until they expire. */
  jwks: JSONWebKeySet;
}

export const SIGNING_ALG = 'EdDSA';

async function toSigningKey(privateKey: CryptoKey, publicJwk: JWK): Promise<SigningKey> {
  const kid = await calculateJwkThumbprint(publicJwk);
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: SIGNING_ALG, use: 'sig' } };
}

/**
 * Loads the Ed25519 signing key from PEM material, plus an optional
 * previous public key kept in the JWKS through a rotation window. With no
 * key material configured (dev only) an ephemeral pair is generated —
 * every restart invalidates outstanding tokens, which for a ≤15-minute
 * TTL is an acceptable dev tradeoff, never a production one.
 */
export async function loadKeyStore(options: {
  privateKeyPem?: string | undefined;
  previousPublicKeyPem?: string | undefined;
}): Promise<KeyStore> {
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  if (options.privateKeyPem !== undefined) {
    // extractable so the public JWK can be derived from the same material.
    privateKey = await importPKCS8(options.privateKeyPem, SIGNING_ALG, { extractable: true });
    // Ed25519 private JWKs embed the public coordinate; strip the secret (d).
    publicJwk = { ...(await exportJWK(privateKey)) };
    delete publicJwk.d;
  } else {
    const pair = await generateKeyPair(SIGNING_ALG, { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
  }
  const current = await toSigningKey(privateKey, publicJwk);

  const keys: JWK[] = [current.publicJwk];
  if (options.previousPublicKeyPem !== undefined) {
    const prevKey = await importSPKI(options.previousPublicKeyPem, SIGNING_ALG);
    const prevJwk = await exportJWK(prevKey);
    const prevKid = await calculateJwkThumbprint(prevJwk);
    keys.push({ ...prevJwk, kid: prevKid, alg: SIGNING_ALG, use: 'sig' });
  }

  return { current, jwks: { keys } };
}
