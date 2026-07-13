/**
 * Public A2A card edge (item 3, SF1): the gateway serves already-signed A2A
 * card projections fetched from the registry over its OWN service identity
 * (svc-gateway, registry:read). The gateway holds no signing key — the
 * registry is the sole signer; this module is a read-through cache.
 *
 * The public routes are UNAUTHENTICATED by design (public read posture:
 * "expose only the signed projection"), so nothing here may forward caller
 * input beyond a shape-validated agent id, and nothing beyond the registry's
 * signed card / index body is ever returned.
 */

import type { Logger } from '@acp/service-kit';

/** Seam the gateway routes read; unit tests stub it, main.ts wires the real one. */
export interface A2ACardSource {
  index(): Promise<A2AEdgeResponse>;
  card(agentId: string): Promise<A2AEdgeResponse>;
}

export interface A2AEdgeResponse {
  status: number;
  body: unknown;
}

export interface RegistryA2ASourceOptions {
  registryUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  logger: Logger;
  /** Short in-proc cache TTL; a public edge must not hammer the registry. */
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  expires: number;
  response: A2AEdgeResponse;
}

export class RegistryA2ASource implements A2ACardSource {
  private readonly cache = new Map<string, CacheEntry>();
  private token: { value: string; expires: number } | undefined;
  private readonly ttl: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RegistryA2ASourceOptions) {
    this.ttl = opts.cacheTtlMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  index(): Promise<A2AEdgeResponse> {
    return this.cached('index', () => this.fetchRegistry('/v1/a2a-cards'));
  }

  card(agentId: string): Promise<A2AEdgeResponse> {
    return this.cached(`card:${agentId}`, () =>
      this.fetchRegistry(`/v1/agents/${agentId}/a2a-card`),
    );
  }

  private async cached(key: string, load: () => Promise<A2AEdgeResponse>): Promise<A2AEdgeResponse> {
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit !== undefined && hit.expires > now) return hit.response;
    const response = await load();
    // Cache 200s AND 404s: a snoop enumerating unknown ids must not become
    // registry load; the TTL keeps a newly exposed agent visible in seconds.
    if (response.status === 200 || response.status === 404) {
      this.cache.set(key, { expires: now + this.ttl, response });
    }
    return response;
  }

  private async fetchRegistry(path: string): Promise<A2AEdgeResponse> {
    const token = await this.serviceToken();
    const res = await this.fetchImpl(`${this.opts.registryUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 200 || res.status === 404) {
      return { status: res.status, body: (await res.json()) as unknown };
    }
    // Anything else (auth failure, registry down) is an upstream problem the
    // public edge reports as 502 without leaking the internal response.
    this.opts.logger.error({ path, status: res.status }, 'a2a card fetch from registry failed');
    return { status: 502, body: { error: { message: 'a2a card source unavailable', status: 502 } } };
  }

  private async serviceToken(): Promise<string> {
    const now = Date.now();
    if (this.token !== undefined && this.token.expires > now + 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.opts.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        audience: 'acp:registry',
        scope: 'registry:read',
      }),
    });
    if (!res.ok) {
      throw new Error(`svc-gateway token mint failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: now + body.expires_in * 1000 };
    return body.access_token;
  }
}
