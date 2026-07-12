/**
 * NATS auth-callout responder (item 0c). Subscribes (queue group) to the
 * system request subject the server publishes connection attempts on,
 * decrypts the sealed request with the responder's xkey, asks BusAuthCore
 * for a decision, signs the authorization response, re-seals it, and replies.
 *
 * Trust model: the request arrives only from the server on $SYS.REQ.USER.AUTH
 * over the system account; the responder itself connects as a platform
 * bypass user. xkey encryption keeps connect credentials unreadable to any
 * other subscriber. The actual authorization decision is the platform-JWT
 * verification in the core — this module is transport only.
 */

import type { AuditEvent } from '@acp/protocol';
import type { Logger } from '@acp/service-kit';
import type { Msg, NatsConnection, Subscription } from 'nats';
import type { AuditSink } from '../app.js';
import type { BusAuthCore } from './core.js';
import { decodeAuthRequest, encodeAuthResponse, type Signer } from './nats-jwt.js';

/** System subject the server publishes connection auth requests on. */
const AUTH_SUBJECT = '$SYS.REQ.USER.AUTH';
const QUEUE_GROUP = 'acp-bus-auth';
/** Header carrying the server's ephemeral curve public key when xkey is on. */
const SERVER_XKEY_HEADER = 'Nats-Server-Xkey';

/** The curve-key surface the responder needs; nkeys' curve keypair satisfies it. */
export interface XKeyPair {
  seal(data: Uint8Array, recipient: string): Uint8Array;
  open(data: Uint8Array, sender: string): Uint8Array;
}

export interface BusAuthResponderDeps {
  nc: NatsConnection;
  core: BusAuthCore;
  /** Responder curve keypair (its public is the server-config `xkey`). */
  xkey: XKeyPair;
  /** Issuer account public key — the response JWT's iss. */
  issuerPublic: string;
  /** ed25519 signer — the issuer account nkey's sign. */
  sign: Signer;
  audit: AuditSink;
  logger: Logger;
  now?: () => Date;
}

export interface BusAuthResponder {
  stop(): Promise<void>;
}

export function startBusAuthResponder(deps: BusAuthResponderDeps): BusAuthResponder {
  const sub: Subscription = deps.nc.subscribe(AUTH_SUBJECT, { queue: QUEUE_GROUP });
  void (async () => {
    for await (const msg of sub) {
      // One slow/failed request must not stall the queue.
      void handle(deps, msg).catch((err: unknown) => {
        deps.logger.error({ err }, 'bus auth responder handler crashed');
      });
    }
  })();
  deps.logger.info({ subject: AUTH_SUBJECT, queue: QUEUE_GROUP }, 'bus auth responder listening');
  return {
    stop: async () => {
      await sub.drain();
    },
  };
}

async function handle(deps: BusAuthResponderDeps, msg: Msg): Promise<void> {
  const serverXkey = msg.headers?.get(SERVER_XKEY_HEADER);
  const encrypted = serverXkey !== undefined && serverXkey !== '';

  let requestToken: string;
  try {
    const raw = encrypted ? deps.xkey.open(msg.data, serverXkey) : msg.data;
    requestToken = new TextDecoder().decode(raw);
  } catch (err) {
    // Cannot decrypt/read → cannot even name the connection; log, drop.
    // The server's auth timeout refuses the connection (fail closed).
    deps.logger.warn({ err }, 'bus auth request could not be decrypted — dropped');
    return;
  }

  let req: ReturnType<typeof decodeAuthRequest>;
  try {
    req = decodeAuthRequest(requestToken);
  } catch (err) {
    deps.logger.warn({ err }, 'bus auth request could not be decoded — dropped');
    return;
  }

  const decision = await deps.core.evaluate({ authToken: req.authToken, userNkey: req.userNkey });

  const response = encodeAuthResponse({
    issuerPublic: deps.issuerPublic,
    userNkey: req.userNkey,
    serverId: req.serverId,
    sign: deps.sign,
    ...(decision.ok ? { userJwt: decision.userJwt } : { error: decision.error }),
  });
  const out = new TextEncoder().encode(response);
  msg.respond(encrypted ? deps.xkey.seal(out, serverXkey) : out);

  // Audit only verified outcomes: an allow, or a token that verified but was
  // refused by policy/kill switch. Unauthenticated scanners (no principal)
  // get a log line, not audit-stream spam (design D6).
  if (decision.ok) {
    await emitBusAuth(deps, decision.tenant, decision.principal, {
      decision: 'allow',
      account: decision.account,
      user_nkey: req.userNkey,
    });
  } else if (decision.principal !== undefined && decision.tenant !== undefined) {
    await emitBusAuth(deps, decision.tenant, decision.principal, {
      decision: 'deny',
      reason: decision.error,
    });
  } else {
    deps.logger.warn(
      { reason: decision.error },
      'bus auth refused an unverified connect (not audited)',
    );
  }
}

async function emitBusAuth(
  deps: BusAuthResponderDeps,
  tenant: string,
  principal: string,
  details: Record<string, unknown>,
): Promise<void> {
  const event: AuditEvent = {
    event_id: crypto.randomUUID(),
    occurred_at: (deps.now?.() ?? new Date()).toISOString(),
    tenant,
    event_type: 'bus.auth',
    actor: { principal, delegation_chain: [{ sub: principal }] },
    action: { name: 'bus.auth' },
    details,
  };
  try {
    await deps.audit.publish(event);
  } catch (err) {
    // R0 fail-open-with-alarm: the connection decision already stands.
    deps.logger.error({ err, principal }, 'bus.auth audit publish failed (fail-open, R0 tier)');
  }
}
