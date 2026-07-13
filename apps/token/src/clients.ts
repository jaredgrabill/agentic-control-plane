import { timingSafeEqual } from 'node:crypto';
import { AuthError } from '@acp/service-kit';

/**
 * A registered platform client: something allowed to authenticate to the
 * Token Service. Humans arrive via OIDC federation in production; in the
 * dev stack, user-shaped clients stand in for the IdP with real
 * (shared-secret) authentication — there is no unauthenticated issuance
 * path in any profile.
 */
export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  /** Principal the issued token speaks for, e.g. user:jane.doe or svc:orchestrator. */
  principal: string;
  tenant: string;
  roles: string[];
  /** Upper bound of scopes this client may ever receive. */
  scopes: string[];
}

export class ClientRegistry {
  private readonly byId: Map<string, RegisteredClient>;

  constructor(clients: RegisteredClient[]) {
    if (clients.length === 0) {
      throw new Error(
        'no token clients configured — set ACP_TOKEN_CLIENTS to a JSON array of registered clients',
      );
    }
    this.byId = new Map(clients.map((c) => [c.client_id, c]));
    if (this.byId.size !== clients.length) {
      throw new Error('duplicate client_id in ACP_TOKEN_CLIENTS');
    }
  }

  static fromJson(json: string): ClientRegistry {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('ACP_TOKEN_CLIENTS is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('ACP_TOKEN_CLIENTS must be a JSON array');
    }
    for (const c of parsed as Partial<RegisteredClient>[]) {
      for (const field of ['client_id', 'client_secret', 'principal', 'tenant'] as const) {
        if (typeof c[field] !== 'string' || c[field] === '') {
          throw new Error(`ACP_TOKEN_CLIENTS entry missing ${field}`);
        }
      }
      if (!Array.isArray(c.roles) || !Array.isArray(c.scopes)) {
        throw new Error(`ACP_TOKEN_CLIENTS entry for ${c.client_id ?? '?'} missing roles/scopes`);
      }
    }
    return new ClientRegistry(parsed as RegisteredClient[]);
  }

  /** True if a client with this id is already registered (static or dynamic). */
  has(clientId: string): boolean {
    return this.byId.has(clientId);
  }

  /**
   * Registers a dynamically-provisioned client (paved-road self-service, SF4).
   * The dynamic client lives in the same in-memory registry as the static seed,
   * so its secret authenticates immediately — but it is NOT persisted, so a
   * token-service restart drops it (a provisioned agent re-provisions, or a
   * durable store replaces this in a later phase). Throws on a duplicate id.
   */
  register(client: RegisteredClient): void {
    if (this.byId.has(client.client_id)) {
      throw new Error(`client_id ${client.client_id} already registered`);
    }
    this.byId.set(client.client_id, client);
  }

  /** Constant-time secret comparison; unknown client and bad secret are indistinguishable to callers. */
  authenticate(clientId: string, clientSecret: string): RegisteredClient {
    const client = this.byId.get(clientId);
    // For unknown clients the comparison runs against the provided secret
    // itself, so timing does not reveal whether the client_id exists.
    const expected = Buffer.from(client?.client_secret ?? clientSecret);
    const provided = Buffer.from(clientSecret);
    const secretOk = expected.length === provided.length && timingSafeEqual(expected, provided);
    if (!secretOk || client === undefined) {
      throw new AuthError('client authentication failed: unknown client_id or wrong client_secret');
    }
    return client;
  }
}
