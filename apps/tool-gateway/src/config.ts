/**
 * Static tool-server registry v1 (deploy/dev/tool-servers.json): which
 * servers exist, which tools on them are governed, how credentials are
 * brokered, and how calls are rate limited. The tools map is BOTH the
 * allowlist and the scope mapping — a tool absent from it cannot be
 * called through the gateway, full stop (no run_command by omission).
 * A registry-backed server catalog replaces this file in a later phase.
 */

import { readFileSync } from 'node:fs';

export interface RateLimitSpec {
  per_minute: number;
  burst: number;
}

export type AuthMode =
  | { mode: 'static-headers'; headers: Record<string, string> }
  | { mode: 'token-exchange'; audience: string; scope: string[] };

export interface ToolSpec {
  /** The delegated scope a caller must hold for Cedar to permit the call. */
  scope: string;
}

export interface ToolServerEntry {
  id: string;
  url: string;
  auth: AuthMode;
  tools: Record<string, ToolSpec>;
  rate_limit: RateLimitSpec;
  /** Per-tool overrides; tools not named fall back to rate_limit. */
  tool_rate_limits?: Record<string, RateLimitSpec> | undefined;
  timeout_ms: number;
}

export interface ToolServerConfig {
  servers: Map<string, ToolServerEntry>;
}

export const CONFIG_SCHEMA = 'acp-tool-servers/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

// ${VAR} or ${VAR:-default} — the shell-parameter shape operators expect.
const VAR_PATTERN = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

export function loadToolServerConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): ToolServerConfig {
  return parseToolServerConfig(readFileSync(path, 'utf8'), env, path);
}

export function parseToolServerConfig(
  text: string,
  env: Record<string, string | undefined>,
  source = 'tool-servers config',
): ToolServerConfig {
  const raw = JSON.parse(text) as {
    schema?: unknown;
    servers?: unknown;
  };
  if (raw.schema !== CONFIG_SCHEMA) {
    throw new Error(
      `${source}: schema must be ${JSON.stringify(CONFIG_SCHEMA)}, got ${JSON.stringify(raw.schema)}`,
    );
  }
  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    throw new Error(`${source}: servers must be a non-empty array`);
  }

  const servers = new Map<string, ToolServerEntry>();
  for (const item of raw.servers as Record<string, unknown>[]) {
    const entry = parseEntry(item, env, source);
    if (servers.has(entry.id)) {
      throw new Error(`${source}: duplicate tool server id ${entry.id}`);
    }
    servers.set(entry.id, entry);
  }
  return { servers };
}

function parseEntry(
  item: Record<string, unknown>,
  env: Record<string, string | undefined>,
  source: string,
): ToolServerEntry {
  const id = item.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${source}: every server needs a non-empty string id`);
  }
  const fail = (message: string): never => {
    throw new Error(`${source}: server ${id}: ${message}`);
  };

  if (typeof item.url !== 'string' || item.url === '') fail('url is required');
  const url = expand(item.url as string, env, source);

  const auth = parseAuth(item.auth, env, source, fail);

  const toolsRaw = item.tools;
  if (!isRecord(toolsRaw) || Object.keys(toolsRaw).length === 0) {
    fail('tools must map at least one governed tool to its required scope');
  }
  const tools: Record<string, ToolSpec> = {};
  for (const [name, spec] of Object.entries(toolsRaw as Record<string, unknown>)) {
    if (!isRecord(spec) || typeof spec.scope !== 'string' || spec.scope === '') {
      fail(`tool ${name} needs a {scope} object`);
    }
    tools[name] = { scope: (spec as { scope: string }).scope };
  }

  const rate_limit = parseRateLimit(item.rate_limit, `rate_limit`, fail);
  let tool_rate_limits: Record<string, RateLimitSpec> | undefined;
  if (item.tool_rate_limits !== undefined) {
    if (!isRecord(item.tool_rate_limits)) fail('tool_rate_limits must be an object');
    tool_rate_limits = {};
    for (const [name, spec] of Object.entries(item.tool_rate_limits as Record<string, unknown>)) {
      tool_rate_limits[name] = parseRateLimit(spec, `tool_rate_limits.${name}`, fail);
    }
  }

  let timeout_ms = DEFAULT_TIMEOUT_MS;
  if (item.timeout_ms !== undefined) {
    if (typeof item.timeout_ms !== 'number' || item.timeout_ms <= 0) {
      fail('timeout_ms must be positive');
    }
    timeout_ms = item.timeout_ms as number;
  }

  return {
    id,
    url,
    auth,
    tools,
    rate_limit,
    ...(tool_rate_limits !== undefined ? { tool_rate_limits } : {}),
    timeout_ms,
  };
}

function parseAuth(
  raw: unknown,
  env: Record<string, string | undefined>,
  source: string,
  fail: (message: string) => never,
): AuthMode {
  if (!isRecord(raw)) fail('auth is required');
  const auth = raw;
  if (auth.mode === 'static-headers') {
    if (!isRecord(auth.headers)) fail('static-headers auth needs a headers object');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(auth.headers)) {
      if (typeof value !== 'string') fail(`header ${name} must be a string`);
      headers[name] = expand(value, env, source);
    }
    return { mode: 'static-headers', headers };
  }
  if (auth.mode === 'token-exchange') {
    if (typeof auth.audience !== 'string' || auth.audience === '') {
      fail('token-exchange auth needs an audience');
    }
    const scope: unknown = auth.scope;
    if (!Array.isArray(scope) || !scope.every((s): s is string => typeof s === 'string')) {
      fail('token-exchange auth needs a scope string array');
    }
    return { mode: 'token-exchange', audience: auth.audience, scope };
  }
  return fail(`unknown auth.mode ${JSON.stringify(auth.mode)}`);
}

function parseRateLimit(
  raw: unknown,
  label: string,
  fail: (message: string) => never,
): RateLimitSpec {
  if (
    !isRecord(raw) ||
    typeof raw.per_minute !== 'number' ||
    raw.per_minute <= 0 ||
    typeof raw.burst !== 'number' ||
    raw.burst < 1
  ) {
    fail(`${label} needs positive {per_minute, burst}`);
  }
  const spec = raw as unknown as RateLimitSpec;
  return { per_minute: spec.per_minute, burst: spec.burst };
}

/**
 * ${VAR} and ${VAR:-default} expansion in config strings. A referenced
 * variable that is unset AND has no default is a startup error — a broker
 * credential must never silently expand to the empty string.
 */
export function expand(
  value: string,
  env: Record<string, string | undefined>,
  source: string,
): string {
  return value.replace(VAR_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    if (fallback !== undefined) return fallback;
    throw new Error(`${source}: environment variable ${name} is not set and has no default`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
