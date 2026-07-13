/**
 * Registry-backed MCP tool-server catalog (item 3, SF3). The catalog is the
 * server.json publication surface: which governed tool servers exist, their
 * tools + scopes + risk, owning team, wrapped system of record, rate limits,
 * and deprecation. It is INTERNAL — it names scope vocabulary and SoR topology,
 * so it is served only on authenticated registry routes, never the public edge.
 *
 * Secrets are NEVER stored: auth.credential_ref holds an env/vault KEY NAME, and
 * the tool gateway expands it at call time. The catalog is opt-in — nothing
 * consumes it until a tool gateway sets ACP_TOOL_CATALOG_URL, so seeding it
 * leaves dev/CI behavior unchanged.
 */

import { toolServerRecord, type ToolServerRecord } from '@acp/protocol';
import type { Pool } from 'pg';

export interface PutToolServerResult {
  outcome: 'inserted' | 'updated';
  record: ToolServerRecord;
}

export interface ToolServerStore {
  migrate(): Promise<void>;
  /** Idempotent seed: insert records that do not yet exist, never overwrite. */
  seed(records: ToolServerRecord[]): Promise<void>;
  put(record: ToolServerRecord): Promise<PutToolServerResult>;
  get(id: string): Promise<ToolServerRecord | undefined>;
  list(): Promise<ToolServerRecord[]>;
}

export class PgToolServerStore implements ToolServerStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tool_servers (
        id         text PRIMARY KEY,
        record     jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async seed(records: ToolServerRecord[]): Promise<void> {
    for (const record of records) {
      await this.pool.query(
        `INSERT INTO tool_servers (id, record) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, JSON.stringify(record)],
      );
    }
  }

  async put(record: ToolServerRecord): Promise<PutToolServerResult> {
    const res = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO tool_servers (id, record, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [record.id, JSON.stringify(record)],
    );
    return { outcome: res.rows[0]?.inserted === true ? 'inserted' : 'updated', record };
  }

  async get(id: string): Promise<ToolServerRecord | undefined> {
    const res = await this.pool.query<{ record: ToolServerRecord }>(
      'SELECT record FROM tool_servers WHERE id = $1',
      [id],
    );
    return res.rows[0]?.record;
  }

  async list(): Promise<ToolServerRecord[]> {
    const res = await this.pool.query<{ record: ToolServerRecord }>(
      'SELECT record FROM tool_servers ORDER BY id',
    );
    return res.rows.map((r) => r.record);
  }
}

const CRED_VAR = /^\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}$/;
const DEFAULT_BROKER_HEADER = 'x-acp-broker-credential';

/**
 * Converts the legacy static tool-servers.json (acp-tool-servers/v1) into
 * server.json catalog records — the backward-compat seed. The static file
 * predates owning_team/wrapped_sor/data_classification, so those are
 * synthesized (the tool gateway's loader ignores them); every field the gateway
 * DOES read (id, url, auth, tools, rate limits, timeout) is carried faithfully.
 *
 * A `static-headers` broker credential becomes `credential-ref` with the env
 * KEY NAME extracted from the ${VAR} header value — the secret itself is never
 * copied into the catalog.
 */
export function staticServersToRecords(raw: unknown): ToolServerRecord[] {
  const doc = raw as { servers?: unknown };
  if (!Array.isArray(doc.servers)) {
    throw new Error('tool-servers seed: expected an object with a servers array');
  }
  return (doc.servers as Record<string, unknown>[]).map((server) => {
    const id = String(server.id);
    const record: ToolServerRecord = {
      id,
      url: String(server.url),
      version: '1.0.0',
      owning_team: 'team-platform',
      wrapped_sor: id,
      data_classification: 'internal',
      auth: toRecordAuth(server.auth),
      // minItems:1 makes this a non-empty tuple; toolServerRecord.parse below
      // is the real guard that the server actually declares ≥1 tool.
      tools: Object.entries(server.tools as Record<string, { scope: string; risk: string }>).map(
        ([name, spec]) => ({
          name,
          scope: spec.scope,
          risk: spec.risk as ToolServerRecord['tools'][number]['risk'],
        }),
      ) as ToolServerRecord['tools'],
      rate_limit: server.rate_limit as ToolServerRecord['rate_limit'],
      ...(server.tool_rate_limits === undefined
        ? {}
        : {
            tool_rate_limits: server.tool_rate_limits as NonNullable<
              ToolServerRecord['tool_rate_limits']
            >,
          }),
      ...(server.timeout_ms === undefined ? {} : { timeout_ms: server.timeout_ms as number }),
    };
    // Fail closed: a malformed synthesized record is a seed error, never a
    // silently-broken catalog row.
    return toolServerRecord.parse(record);
  });
}

function toRecordAuth(raw: unknown): ToolServerRecord['auth'] {
  const auth = raw as {
    mode?: string;
    headers?: Record<string, string>;
    audience?: string;
    scope?: string[];
  };
  if (auth.mode === 'token-exchange') {
    return {
      mode: 'token-exchange',
      ...(auth.audience === undefined ? {} : { audience: auth.audience }),
      ...(auth.scope === undefined ? {} : { scope: auth.scope }),
    };
  }
  // static-headers → credential-ref: pull the env KEY NAME out of the ${VAR}
  // header value; the default fallback (and the secret) are deliberately dropped.
  const headers = auth.headers ?? {};
  const [header, value] = Object.entries(headers)[0] ?? [DEFAULT_BROKER_HEADER, ''];
  const match = CRED_VAR.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(
      `tool-servers seed: static-headers credential ${JSON.stringify(value)} is not a \${VAR} reference`,
    );
  }
  return { mode: 'credential-ref', credential_ref: match[1], header };
}
