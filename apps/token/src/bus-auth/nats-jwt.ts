/**
 * Vendored NATS v2 JWT encoder/decoder for the auth-callout responder
 * (item 0c). We deliberately do NOT depend on @nats-io/jwt: the surface we
 * need is ~100 lines, and vendoring keeps the trust-boundary code auditable
 * in-tree and free of an extra supply-chain edge. The signing primitive is
 * injected (the account nkey's ed25519 `sign`), so this module is pure and
 * unit-tested without any keys of its own.
 *
 * Wire format (nats-server 2.x): `base64url(header).base64url(claims).
 * base64url(sig)`, no padding; header `{typ:JWT, alg:ed25519-nkey}`; the
 * signature is ed25519 over the UTF-8 bytes of `header.claims`. The server
 * validates the response JWT's signature against the configured `issuer`
 * account key and the embedded user JWT the same way — it never recomputes
 * the `jti` hash, so a random jti is sufficient and correct.
 */

import { randomUUID } from 'node:crypto';

/** ed25519 signer — the account nkey's `sign`. */
export type Signer = (data: Uint8Array) => Uint8Array;

/** NATS subject permission set (allow/deny lists of subjects). */
export interface SubjectPermission {
  allow?: string[];
  deny?: string[];
}

export interface NatsPermissions {
  pub: SubjectPermission;
  sub: SubjectPermission;
}

const HEADER = { typ: 'JWT', alg: 'ed25519-nkey' };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function b64urlText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function encodeJwt(claims: Record<string, unknown>, sign: Signer): string {
  const signingInput = `${b64urlText(JSON.stringify(HEADER))}.${b64urlText(JSON.stringify(claims))}`;
  const sig = sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export interface UserJwtParams {
  /** Issuer account public key (A…) — trusted by the server as `issuer`. */
  issuerPublic: string;
  /** The ephemeral user nkey (U…) the server generated for this connection. */
  userNkey: string;
  /** Target account NAME (config-mode auth callout keys the account by name). */
  account: string;
  /** Human-readable name — the platform token's sub, for server logs/monitoring. */
  name: string;
  /** Expiry (unix seconds) — the bus identity dies with the platform token. */
  expUnix: number;
  permissions: NatsPermissions;
  sign: Signer;
}

/** Mints the session user JWT the connection will run under. */
export function encodeUserJwt(p: UserJwtParams): string {
  return encodeJwt(
    {
      jti: randomUUID(),
      iat: nowUnix(),
      iss: p.issuerPublic,
      sub: p.userNkey,
      aud: p.account,
      name: p.name,
      exp: p.expUnix,
      nats: {
        pub: p.permissions.pub,
        sub: p.permissions.sub,
        subs: -1,
        type: 'user',
        version: 2,
      },
    },
    p.sign,
  );
}

export interface AuthResponseParams {
  issuerPublic: string;
  /** The connection's user nkey (U…) — the response subject. */
  userNkey: string;
  /** The requesting server's id — the response audience. */
  serverId: string;
  sign: Signer;
  /** On success: the minted user JWT. */
  userJwt?: string | undefined;
  /** On failure: the reason (a validation/policy refusal). Mutually exclusive with userJwt. */
  error?: string | undefined;
}

/** Wraps the mint (or an error) in the authorization_response JWT the server expects. */
export function encodeAuthResponse(p: AuthResponseParams): string {
  const nats: Record<string, unknown> = {
    type: 'authorization_response',
    version: 2,
  };
  if (p.error !== undefined) {
    nats.error = p.error;
  } else if (p.userJwt !== undefined) {
    nats.jwt = p.userJwt;
  }
  return encodeJwt(
    {
      jti: randomUUID(),
      iat: nowUnix(),
      iss: p.issuerPublic,
      sub: p.userNkey,
      aud: p.serverId,
      nats,
    },
    p.sign,
  );
}

export interface DecodedAuthRequest {
  /** The ephemeral user nkey (U…) — becomes the minted user JWT's sub. */
  userNkey: string;
  /** The requesting server's id — becomes the response audience. */
  serverId: string;
  /** The token the agent presented via connect({ token }); the platform JWT. */
  authToken: string | undefined;
}

interface RawAuthRequest {
  nats?: {
    user_nkey?: unknown;
    server_id?: unknown;
    connect_opts?: { auth_token?: unknown };
  };
}

/**
 * Decodes the authorization_request JWT's claims. The signature is NOT
 * verified here: the request arrives only from the server on the system
 * subject $SYS.REQ.USER.AUTH (a channel only the server publishes to), and
 * the security decision rests on the platform JWT inside connect_opts, which
 * the core verifies against the token-service key set.
 */
export function decodeAuthRequest(token: string): DecodedAuthRequest {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`malformed auth request JWT: expected 3 segments, got ${parts.length}`);
  }
  const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown;
  const nats = (payload as RawAuthRequest).nats;
  if (nats === undefined) {
    throw new Error('auth request JWT carries no nats claim');
  }
  const userNkey = typeof nats.user_nkey === 'string' ? nats.user_nkey : undefined;
  if (userNkey === undefined) {
    throw new Error('auth request JWT has no nats.user_nkey');
  }
  // server_id is an object { id, name, host, … } in v2; tolerate a bare string.
  const rawServer = nats.server_id;
  let serverId: string | undefined;
  if (typeof rawServer === 'string') {
    serverId = rawServer;
  } else if (typeof rawServer === 'object' && rawServer !== null) {
    const id = (rawServer as { id?: unknown }).id;
    serverId = typeof id === 'string' ? id : undefined;
  }
  if (serverId === undefined) {
    throw new Error('auth request JWT has no nats.server_id.id');
  }
  const authToken = nats.connect_opts?.auth_token;
  return {
    userNkey,
    serverId,
    authToken: typeof authToken === 'string' ? authToken : undefined,
  };
}
