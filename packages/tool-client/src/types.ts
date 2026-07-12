/**
 * The ToolClient seam (paved-road.md): agents call named tool servers
 * through this interface and never touch transport. Item 5's Tool Gateway
 * swaps the binding under the same interface — agents stay untouched.
 */

/**
 * Document-granularity provenance carried by every tool response. Shape is
 * Citation-compatible so handlers can cite tool data directly.
 */
export interface Provenance {
  doc_id: string;
  version: string;
  lineage_id: string;
  effective_date?: string;
  url?: string;
}

/** A successful tool call: structured data plus the provenance that grounds it. */
export interface ToolResponse {
  data: Record<string, unknown>;
  provenance: Provenance[];
  /** True when the tool could only answer part of the question. */
  partial?: boolean;
  /** For partial responses: what is missing and why. */
  gaps?: string[];
}

/** The only door from a capability handler to a tool server. */
export interface ToolClient {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResponse>;
}

/**
 * The wire envelope every ACP tool result rides in (inside MCP
 * `structuredContent`, mirrored into `content[0].text` as JSON). Errors are
 * typed on the wire so the client maps them onto the CapabilityError
 * taxonomy deterministically — no message sniffing.
 */
export type ToolEnvelope =
  | {
      ok: true;
      data: Record<string, unknown>;
      provenance: Provenance[];
      partial?: boolean;
      gaps?: string[];
    }
  | {
      ok: false;
      error: {
        code: 'rate_limited' | 'unavailable' | 'invalid_input' | 'not_found' | 'upstream_auth';
        message: string;
        retry_after_s?: number;
      };
    };
