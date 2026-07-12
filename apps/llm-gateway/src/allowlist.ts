/**
 * The manifest model allowlist, enforced at the gateway PEP: an agent
 * caller may only complete against classes its registered card declares
 * in `models.allowed`. Cards are fetched with the gateway's OWN
 * registry:read credentials (never the caller's token) and cached for a
 * short TTL, so the registry round-trip stays off the hot path. A
 * registry outage FAILS CLOSED as 503 — an unverifiable allowlist is not
 * an open one.
 */

export class RegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

export interface AllowlistCheck {
  allowed: boolean;
  /** The card's models.allowed (empty when the card has no models block). */
  allowedClasses: string[];
}

export interface RegistryAllowlistOptions {
  registryUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** Card cache TTL. Default 30s. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  allowedClasses: string[];
  expiresAt: number;
}

export class RegistryAllowlist {
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: RegistryAllowlistOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Throws RegistryUnavailableError when the allowlist cannot be verified. */
  async check(agentId: string, modelClass: string): Promise<AllowlistCheck> {
    const allowedClasses = await this.allowedClassesFor(agentId);
    return { allowed: allowedClasses.includes(modelClass), allowedClasses };
  }

  private async allowedClassesFor(agentId: string): Promise<string[]> {
    const cached = this.cache.get(agentId);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.allowedClasses;
    }
    const allowedClasses = await this.fetchAllowedClasses(agentId);
    this.cache.set(agentId, { allowedClasses, expiresAt: this.now() + this.ttlMs });
    return allowedClasses;
  }

  private async fetchAllowedClasses(agentId: string): Promise<string[]> {
    let token: string;
    try {
      token = await this.mintToken();
    } catch (err) {
      throw new RegistryUnavailableError(
        `token service refused the llm-gateway registry client: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.registryUrl}/v1/agents/${agentId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new RegistryUnavailableError(
        `registry unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 404) {
      // A caller acting as an unregistered agent gets an EMPTY allowlist —
      // deterministic deny, not an outage.
      return [];
    }
    if (!res.ok) {
      throw new RegistryUnavailableError(`registry answered ${res.status} for agent ${agentId}`);
    }
    const card = (await res.json()) as {
      manifest?: { models?: { allowed?: string[] } };
    };
    return card.manifest?.models?.allowed ?? [];
  }

  private async mintToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.options.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: 'acp:registry',
        scope: 'registry:read',
      }),
    });
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    const { access_token } = (await res.json()) as { access_token: string };
    return access_token;
  }
}
