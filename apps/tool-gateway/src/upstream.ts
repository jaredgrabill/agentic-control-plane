/**
 * Upstream MCP connections. SECURITY INVARIANT: the caller's Authorization
 * header can never reach an upstream server — this module receives ONLY
 * the headers the credential broker built (broker credential or exchanged
 * token, plus x-acp-* correlation), and nothing else carries headers into
 * the transport. Upstream credentials are likewise never agent-visible:
 * they exist only between this pool and the server.
 *
 * A fresh Client + transport is built per call: headers are per-caller
 * (brokered), which makes connection pooling non-trivial; the per-call
 * handshake is acceptable at dev scale and pooling is a Phase 3 concern.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type UpstreamBinding = { url: string } | { transport: () => Transport };

const DEFAULT_LIST_TTL_MS = 60_000;

interface CachedList {
  tools: Tool[];
  fetchedAtMs: number;
}

export class UpstreamPool {
  private readonly listCache = new Map<string, CachedList>();
  private readonly listTtlMs: number;

  constructor(
    private readonly bindings: Record<string, UpstreamBinding>,
    options: { listTtlMs?: number; now?: () => number } = {},
  ) {
    this.listTtlMs = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  /** Cached tools/list (public, unauthenticated metadata), TTL-refreshed. */
  async listTools(serverId: string): Promise<Tool[]> {
    const cached = this.listCache.get(serverId);
    if (cached !== undefined && this.now() - cached.fetchedAtMs < this.listTtlMs) {
      return cached.tools;
    }
    const client = this.connectClient(serverId, {});
    try {
      const { tools } = await (await client).listTools();
      this.listCache.set(serverId, { tools, fetchedAtMs: this.now() });
      return tools;
    } finally {
      await (await client).close().catch(() => undefined);
    }
  }

  /**
   * The advertised metadata for one tool. A miss forces one refresh — a
   * freshly-deployed upstream tool must not stay invisible for a TTL.
   */
  async toolInfo(serverId: string, tool: string): Promise<Tool | undefined> {
    const tools = await this.listTools(serverId);
    const found = tools.find((t) => t.name === tool);
    if (found !== undefined) return found;
    this.listCache.delete(serverId);
    return (await this.listTools(serverId)).find((t) => t.name === tool);
  }

  async callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<CallToolResult> {
    const client = await this.connectClient(serverId, headers);
    try {
      return (await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: timeoutMs,
      })) as CallToolResult;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async connectClient(serverId: string, headers: Record<string, string>): Promise<Client> {
    const binding = this.bindings[serverId];
    if (binding === undefined) {
      throw new Error(`no upstream binding for tool server ${serverId}`);
    }
    const client = new Client({ name: 'acp-tool-gateway', version: '0.1.0' });
    const transport: Transport =
      'url' in binding
        ? // Cast bridges the SDK's `string | undefined` sessionId vs the
          // optional Transport field under exactOptionalPropertyTypes.
          (new StreamableHTTPClientTransport(new URL(binding.url), {
            requestInit: { headers },
          }) as Transport)
        : binding.transport();
    await client.connect(transport);
    return client;
  }
}
