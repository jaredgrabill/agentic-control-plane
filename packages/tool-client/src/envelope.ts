/**
 * ToolEnvelope helpers shared by everything that speaks the ACP tool wire
 * shape: mock servers build results with ok()/fail()/toCallToolResult(),
 * and both the client and the Tool Gateway parse results back with
 * parseToolEnvelope(). One implementation, no drift.
 */

import type { Provenance, ToolEnvelope, ToolErrorCode } from './types.js';

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

export function fail(code: ToolErrorCode, message: string, retryAfterS?: number): ToolEnvelope {
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

const ERROR_CODES: readonly string[] = [
  'rate_limited',
  'unavailable',
  'invalid_input',
  'not_found',
  'upstream_auth',
];

/**
 * Pulls the ToolEnvelope out of an MCP CallToolResult: `structuredContent`
 * first, envelope JSON in `content[0].text` as the fallback. Shape-checked —
 * ok:true requires a data record and a provenance array, ok:false requires a
 * known error code and a message. Anything else is `undefined` (malformed),
 * never a partially-trusted envelope.
 */
export function parseToolEnvelope(result: unknown): ToolEnvelope | undefined {
  if (!isRecord(result)) return undefined;
  const candidate = isRecord(result.structuredContent)
    ? result.structuredContent
    : parseTextContent(result.content);
  if (candidate === undefined) return undefined;
  if (candidate.ok === true) {
    if (!isRecord(candidate.data) || !Array.isArray(candidate.provenance)) return undefined;
    return candidate as ToolEnvelope;
  }
  if (candidate.ok === false && isRecord(candidate.error)) {
    if (
      typeof candidate.error.code !== 'string' ||
      !ERROR_CODES.includes(candidate.error.code) ||
      typeof candidate.error.message !== 'string'
    ) {
      return undefined;
    }
    return candidate as ToolEnvelope;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTextContent(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (!isRecord(first) || typeof first.text !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
