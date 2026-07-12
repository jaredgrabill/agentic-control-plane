/**
 * Retriever: the only door to the knowledge store (paved-road.md).
 *
 * Per security.md, an agent calling platform infrastructure exchanges its
 * delegated token for one bound to the target audience (RFC 8693) — the chain
 * grows, scopes intersect — then rides NATS request-reply on
 * acp.platform.svc.knowledge.search.
 */

import { context, propagation } from '@opentelemetry/api';
import { subjects } from '@acp/protocol';
import { CapabilityError, ErrorClass } from './errors.js';

export const KNOWLEDGE_AUDIENCE = 'acp:knowledge';

export interface SearchOptions {
  /** Result count, default 8. */
  k?: number;
  taskId?: string;
  stepId?: string;
}

/** Citation-carrying retrieval under the step's delegated identity. */
export interface Retriever {
  search(
    delegatedToken: string,
    query: string,
    options?: SearchOptions,
  ): Promise<Record<string, unknown>[]>;
}

/**
 * Exchanges the step's delegated token for a knowledge-audience token using
 * the agent's own client credentials. Non-platform clients cannot name a
 * different actor, so the minted token acts as this agent.
 */
export class TokenExchanger {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    /** Test seam — the Python SDK's httpx transport, as a fetch. */
    fetchImpl?: typeof fetch;
  }) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exchange(subjectToken: string, audience: string): Promise<string> {
    const res = await this.fetchImpl(`${this.tokenUrl}/v1/token/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        audience,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new CapabilityError(
        ErrorClass.PolicyDenied,
        `token exchange for ${audience} refused (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }
}

/**
 * The narrow slice of a NATS connection the retriever needs; `NatsConnection`
 * from the `nats` package satisfies it structurally.
 */
export interface BusClient {
  request(
    subject: string,
    payload: Uint8Array,
    options: { timeout: number },
  ): Promise<{ data: Uint8Array }>;
}

/**
 * Citation-carrying retrieval over the bus. Every result includes the
 * citation (doc id, version, effective date, lineage_id) the answer builder
 * needs — agents cannot cite what the store cannot attribute.
 */
export class NatsRetriever implements Retriever {
  private readonly nc: BusClient;
  private readonly exchanger: TokenExchanger;
  private readonly timeoutMs: number;

  constructor(options: { nc: BusClient; exchanger: TokenExchanger; timeoutMs?: number }) {
    this.nc = options.nc;
    this.exchanger = options.exchanger;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(
    delegatedToken: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<Record<string, unknown>[]> {
    const knowledgeToken = await this.exchanger.exchange(delegatedToken, KNOWLEDGE_AUDIENCE);
    const payload: Record<string, unknown> = {
      token: knowledgeToken,
      query,
      k: options.k ?? 8,
    };
    if (options.taskId !== undefined) payload.task_id = options.taskId;
    if (options.stepId !== undefined) payload.step_id = options.stepId;
    // W3C context rides the request so the retrieval hop joins the task
    // trace (observability.md: context propagation is SDK plumbing).
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    if (carrier.traceparent !== undefined) payload.traceparent = carrier.traceparent;

    let reply: { data: Uint8Array };
    try {
      reply = await this.nc.request(
        subjects.svc('knowledge', 'search'),
        new TextEncoder().encode(JSON.stringify(payload)),
        { timeout: this.timeoutMs },
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'TIMEOUT') {
        throw new CapabilityError(
          ErrorClass.Retryable,
          'knowledge service did not answer within the timeout',
        );
      }
      throw err;
    }
    const body = JSON.parse(new TextDecoder().decode(reply.data)) as Record<string, unknown>;
    if ('error' in body) {
      const error = body.error as { status?: number; message?: string };
      const status = error.status ?? 500;
      throw new CapabilityError(
        status === 403 ? ErrorClass.PolicyDenied : ErrorClass.Retryable,
        `knowledge search failed (${status}): ${error.message ?? 'unknown'}`,
      );
    }
    return body.results as Record<string, unknown>[];
  }
}
