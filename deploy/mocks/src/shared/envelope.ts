/**
 * ToolEnvelope helpers: every mock tool result rides the same wire shape —
 * `structuredContent` carries the envelope, `content[0].text` mirrors it as
 * JSON for MCP clients that only read text content.
 */

import type { Provenance, ToolEnvelope } from '@acp/tool-client';

export function ok(
  data: Record<string, unknown>,
  provenance: Provenance[],
  options: { partial?: boolean; gaps?: string[] } = {},
): ToolEnvelope {
  return {
    ok: true,
    data,
    provenance,
    ...(options.partial !== undefined ? { partial: options.partial } : {}),
    ...(options.gaps !== undefined ? { gaps: options.gaps } : {}),
  };
}

export function fail(
  code: 'rate_limited' | 'unavailable' | 'invalid_input' | 'not_found' | 'upstream_auth',
  message: string,
  retryAfterS?: number,
): ToolEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(retryAfterS !== undefined ? { retry_after_s: retryAfterS } : {}),
    },
  };
}

/** The MCP CallToolResult wrapper: structured content + JSON text mirror + isError. */
export function toCallToolResult(envelope: ToolEnvelope): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: !envelope.ok,
  };
}
