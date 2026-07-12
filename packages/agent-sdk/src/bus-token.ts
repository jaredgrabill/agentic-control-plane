/**
 * BusTokenSource (item 0c): mints and refreshes the acp:bus token an agent
 * presents to the NATS auth callout. The token is a client_credentials mint
 * against the agent's OWN client (scopes stay []), audience acp:bus, ≤15min.
 * A background refresh re-mints at ~2/3 TTL so a reconnect always presents a
 * live token — the minted bus identity dies with its token, so the session
 * must be renewed before expiry.
 *
 * Used only by served agents (worker.ts); the mint + scheduling logic is
 * unit-tested here (the connection wiring is E2E-covered).
 */

export const BUS_AUDIENCE = 'acp:bus';

export interface BusTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  audience?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Re-mint at this fraction of the TTL (default 2/3). */
  refreshRatio?: number;
  /** Boot-retry backoff cap in ms (default 30_000). */
  maxBackoffMs?: number;
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export class BusTokenSource {
  private current = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly audience: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshRatio: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: BusTokenOptions) {
    this.audience = options.audience ?? BUS_AUDIENCE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshRatio = options.refreshRatio ?? 2 / 3;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  /** The current bus token; the tokenAuthenticator reads this per connect attempt. */
  token(): string {
    if (this.current === '') {
      throw new Error('bus token not yet minted — call start() first');
    }
    return this.current;
  }

  /** Mints the first token (retrying on the boot race with the token service) and schedules refresh. */
  async start(): Promise<void> {
    let backoff = 500;
    for (;;) {
      try {
        await this.refresh();
        return;
      } catch (err) {
        if (this.stopped) return;
        this.options.logger?.warn({ err }, 'bus token mint failed; retrying');
        await delay(Math.min(backoff, this.maxBackoffMs));
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  /** One mint attempt; throws on network or non-2xx. */
  async mint(): Promise<{ token: string; expiresIn: number }> {
    const res = await this.fetchImpl(`${this.options.tokenUrl}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: this.audience,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`bus token mint refused (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return { token: body.access_token, expiresIn: body.expires_in };
  }

  private async refresh(): Promise<void> {
    const { token, expiresIn } = await this.mint();
    this.current = token;
    if (this.stopped) return;
    const delayMs = Math.max(1_000, Math.floor(expiresIn * 1_000 * this.refreshRatio));
    this.timer = setTimeout(() => {
      void this.refresh().catch((err: unknown) => {
        // A failed refresh leaves the last token in place; the next reconnect
        // or the following scheduled attempt recovers. Reschedule soon.
        this.options.logger?.error({ err }, 'bus token refresh failed; retrying shortly');
        if (!this.stopped)
          this.timer = setTimeout(() => void this.refresh().catch(() => undefined), 5_000);
      });
    }, delayMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
