/**
 * Generates a NATS auth-callout key set for the dev stack (item 0c):
 *
 *   - an ACCOUNT nkey (SA…/A…) — the issuer that signs minted user JWTs and
 *     authorization responses; its public goes in nats-server.conf `issuer`.
 *   - a CURVE (xkey) keypair (SX…/X…) — seals the auth request/response so an
 *     unprivileged bus subscriber cannot read connect credentials; its public
 *     goes in nats-server.conf `xkey`.
 *
 *   node scripts/gen-bus-auth-keys.mjs
 *
 * The dev seeds are COMMITTED (nats-server.conf, run-platform.mjs, compose
 * defaults) — they are local-stack-only, like every other dev credential.
 * A hardened deployment vaults fresh seeds and injects them via env
 * (ACP_NATS_AUTH_ISSUER_SEED, ACP_NATS_AUTH_XKEY_SEED).
 */
import console from 'node:console';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// A bare script cannot resolve the workspace `nats` dep; resolve it through
// service-kit, which declares it.
const require = createRequire(join(repoRoot, 'packages', 'service-kit', 'package.json'));
const { nkeys } = require('nats');

const account = nkeys.createAccount();
const xkey = nkeys.createCurve();
const dec = (u8) => new TextDecoder().decode(u8);

const keys = {
  ACP_NATS_AUTH_ISSUER_SEED: dec(account.getSeed()),
  issuer_public: account.getPublicKey(),
  ACP_NATS_AUTH_XKEY_SEED: dec(xkey.getSeed()),
  xkey_public: xkey.getPublicKey(),
};

console.log(JSON.stringify(keys, null, 2));
console.log(
  '\n# nats-server.conf auth_callout: issuer=%s xkey=%s',
  keys.issuer_public,
  keys.xkey_public,
);
