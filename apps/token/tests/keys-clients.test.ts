import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { ClientRegistry } from '../src/clients.js';
import { loadKeyStore } from '../src/keys.js';

describe('loadKeyStore', () => {
  it('loads a configured PKCS8 key and never exposes the private part in JWKS', async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const pem = await exportPKCS8(pair.privateKey);
    const store = await loadKeyStore({ privateKeyPem: pem, previousPublicKeyPem: undefined });
    expect(store.jwks.keys).toHaveLength(1);
    expect(store.jwks.keys[0]).not.toHaveProperty('d');
    expect(store.jwks.keys[0]!.kid).toBe(store.current.kid);
  });

  it('keeps a previous public key in the JWKS through a rotation window', async () => {
    const current = await generateKeyPair('EdDSA', { extractable: true });
    const previous = await generateKeyPair('EdDSA', { extractable: true });
    const store = await loadKeyStore({
      privateKeyPem: await exportPKCS8(current.privateKey),
      previousPublicKeyPem: await exportSPKI(previous.publicKey),
    });
    expect(store.jwks.keys).toHaveLength(2);
    const kids = store.jwks.keys.map((k) => k.kid);
    expect(new Set(kids).size).toBe(2);
  });
});

describe('ClientRegistry.fromJson', () => {
  const valid = JSON.stringify([
    {
      client_id: 'a',
      client_secret: 's',
      principal: 'user:a',
      tenant: 'acme',
      roles: [],
      scopes: [],
    },
  ]);

  it('parses a valid registration', () => {
    expect(() => ClientRegistry.fromJson(valid)).not.toThrow();
  });

  it.each([
    ['not json', /not valid JSON/],
    ['{}', /must be a JSON array/],
    ['[{"client_id":"a"}]', /missing client_secret/],
    ['[{"client_id":"a","client_secret":"s","principal":"p","tenant":"t"}]', /roles\/scopes/],
    ['[]', /no token clients configured/],
  ])('rejects %s', (json, pattern) => {
    expect(() => ClientRegistry.fromJson(json)).toThrow(pattern);
  });

  it('rejects duplicate client ids', () => {
    const [entry] = JSON.parse(valid) as [Record<string, unknown>];
    const dup = JSON.stringify([entry, entry]);
    expect(() => ClientRegistry.fromJson(dup)).toThrow(/duplicate/);
  });
});
