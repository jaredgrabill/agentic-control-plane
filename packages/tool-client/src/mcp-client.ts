/**
 * McpToolClient: ToolClient over MCP Streamable HTTP via the official
 * @modelcontextprotocol/sdk. All SDK contact lives in this module so SDK
 * churn stays contained.
 *
 * Error mapping is normative (unit-tested row by row):
 *
 * | Condition                                   | CapabilityError class |
 * |---------------------------------------------|-----------------------|
 * | network / connect failure                   | retryable             |
 * | MCP request timeout                         | retryable             |
 * | HTTP 401/403                                | policy_denied         |
 * | envelope rate_limited                       | retryable (+details)  |
 * | envelope unavailable                        | retryable             |
 * | envelope upstream_auth                      | policy_denied         |
 * | envelope invalid_input                      | permanent (agent bug) |
 * | envelope not_found                          | needs_input           |
 * | malformed / unparseable result              | permanent             |
 *
 * There is no rate_limited class in the taxonomy: it maps to retryable with
 * details.retry_after_s; Temporal's retry policy (max 3 attempts) is the v0
 * backoff. There is no timeout code on the wire — a timeout is the server
 * not answering, so it surfaces client-side.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CapabilityError, ErrorClass } from '@acp/agent-sdk';
import { parseToolEnvelope } from './envelope.js';
import type { ToolTokenProvider } from './exchanger.js';
import type { CallOptions, ToolClient, ToolResponse } from './types.js';

/**
 * How to reach a named tool server: an HTTP URL (the `/mcp` endpoint), or a
 * transport factory for hermetic in-memory wiring in tests and evals.
 */
export type ServerBinding =
  { url: string; headers?: Record<string, string> } | { transport: () => Transport };

const DEFAULT_TIMEOUT_MS = 15_000;

// Widened once: McpError.code is a plain number on the wire, so the enum
// member is compared as one.
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

export class McpToolClient implements ToolClient {
  private readonly servers: Record<string, ServerBinding>;
  private readonly timeoutMs: number;
  /**
   * When set (Phase 3 item 0c), the step's delegated token is exchanged for
   * an `acp:tools` token before it becomes the gateway Authorization bearer.
   * Unset agents send the delegated token verbatim (dev/test seam).
   */
  private readonly tokenProvider: ToolTokenProvider | undefined;

  constructor(options: {
    servers: Record<string, ServerBinding>;
    timeoutMs?: number;
    tokenProvider?: ToolTokenProvider;
  }) {
    this.servers = options.servers;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenProvider = options.tokenProvider;
  }

  /**
   * One MCP client + transport per call: connect, call, close. The per-call
   * handshake is acceptable against the dev mocks; connection pooling is the
   * Tool Gateway's job (Item 5), not this seam's.
   *
   * URL bindings forward the per-call identity: the delegated token as the
   * Authorization bearer, task/step ids as x-acp-* correlation headers.
   * Transport-factory bindings (hermetic in-memory tests) ignore headers.
   */
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<ToolResponse> {
    const binding = this.servers[server];
    if (binding === undefined) {
      throw new CapabilityError(
        ErrorClass.Permanent,
        `no endpoint configured for tool server ${server}`,
      );
    }
    const client = new Client({ name: 'acp-tool-client', version: '0.1.0' });
    // Exchange the delegated token for an acp:tools token only for URL
    // bindings — transport-factory bindings (hermetic in-memory tests)
    // ignore headers entirely, so there is no bearer to bind and no reason
    // to spend a round trip. The exchanged token is the ONLY token that ever
    // reaches the gateway; the raw delegated token never leaves this call.
    const effectiveOptions =
      'url' in binding && this.tokenProvider !== undefined && options?.delegatedToken !== undefined
        ? { ...options, delegatedToken: await this.tokenProvider(options.delegatedToken) }
        : options;
    const transport: Transport =
      'url' in binding
        ? // The SDK types sessionId as `string | undefined` where Transport
          // declares `sessionId?: string`; the cast bridges the
          // exactOptionalPropertyTypes mismatch, nothing more.
          (new StreamableHTTPClientTransport(new URL(binding.url), {
            requestInit: { headers: callHeaders(binding.headers, effectiveOptions) },
          }) as Transport)
        : binding.transport();
    try {
      let result: unknown;
      try {
        await client.connect(transport);
        result = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: this.timeoutMs,
        });
      } catch (err) {
        throw this.mapTransportError(server, tool, err);
      }
      return this.parseResult(server, tool, result);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private mapTransportError(server: string, tool: string, err: unknown): CapabilityError {
    if (err instanceof McpError && err.code === REQUEST_TIMEOUT_CODE) {
      return new CapabilityError(
        ErrorClass.Retryable,
        `tool ${server}.${tool} did not answer within ${this.timeoutMs}ms`,
      );
    }
    if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
      return new CapabilityError(
        ErrorClass.PolicyDenied,
        `tool server ${server} refused the call (${err.code})`,
      );
    }
    if (err instanceof McpError) {
      // A JSON-RPC-level error (unknown tool, invalid params, server crash)
      // is a contract violation between agent and tool, not a transient.
      return new CapabilityError(
        ErrorClass.Permanent,
        `tool ${server}.${tool} failed: ${err.message}`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return new CapabilityError(
      ErrorClass.Retryable,
      `tool server ${server} unreachable: ${message}`,
    );
  }

  private parseResult(server: string, tool: string, result: unknown): ToolResponse {
    const malformed = () =>
      new CapabilityError(
        ErrorClass.Permanent,
        `tool ${server}.${tool} returned a malformed result`,
      );
    const envelope = parseToolEnvelope(result);
    if (envelope === undefined) throw malformed();

    if (!envelope.ok) {
      const error = envelope.error;
      switch (error.code) {
        case 'rate_limited': {
          const retryAfter = error.retry_after_s;
          if (typeof retryAfter === 'number') {
            throw new CapabilityError(
              ErrorClass.Retryable,
              `tool ${server}.${tool} rate limited — retry after ${retryAfter}s`,
              { retry_after_s: retryAfter },
            );
          }
          throw new CapabilityError(ErrorClass.Retryable, error.message);
        }
        case 'unavailable':
          throw new CapabilityError(ErrorClass.Retryable, error.message);
        case 'upstream_auth':
          throw new CapabilityError(ErrorClass.PolicyDenied, error.message);
        case 'invalid_input':
          throw new CapabilityError(ErrorClass.Permanent, error.message);
        case 'not_found':
          throw new CapabilityError(ErrorClass.NeedsInput, error.message);
      }
    }

    const response: ToolResponse = {
      data: envelope.data,
      provenance: envelope.provenance,
    };
    if (envelope.partial !== undefined) response.partial = envelope.partial;
    if (envelope.gaps !== undefined) response.gaps = envelope.gaps;
    return response;
  }
}

/** Static binding headers + per-call identity/correlation headers. */
function callHeaders(
  bindingHeaders: Record<string, string> | undefined,
  options: CallOptions | undefined,
): Record<string, string> {
  return {
    ...bindingHeaders,
    ...(options?.delegatedToken !== undefined
      ? { authorization: `Bearer ${options.delegatedToken}` }
      : {}),
    ...(options?.taskId !== undefined ? { 'x-acp-task-id': options.taskId } : {}),
    ...(options?.stepId !== undefined ? { 'x-acp-step-id': options.stepId } : {}),
  };
}
