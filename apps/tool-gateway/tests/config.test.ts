import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolServerRecord } from '@acp/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  expand,
  loadToolServerCatalog,
  loadToolServerConfig,
  parseToolServerConfig,
  recordToEntry,
} from '../src/config.js';

const SAMPLE = {
  schema: 'acp-tool-servers/v1',
  servers: [
    {
      id: 'cloud-estate',
      url: 'http://localhost:7301/mcp',
      auth: {
        mode: 'static-headers',
        headers: {
          'x-acp-broker-credential': '${ACP_TOOL_CRED_CLOUD_ESTATE:-cloud-estate-dev-broker}',
        },
      },
      tools: {
        inventory_search: { scope: 'cloud:inventory:read', risk: 'R0' },
        cost_report: { scope: 'cloud:cost:read', risk: 'R0' },
      },
      rate_limit: { per_minute: 60, burst: 20 },
      timeout_ms: 15000,
    },
    {
      id: 'knowledge',
      url: 'http://localhost:7105/mcp',
      auth: { mode: 'token-exchange', audience: 'acp:knowledge', scope: ['knowledge:search:read'] },
      tools: { knowledge_search: { scope: 'knowledge:search:read', risk: 'R0' } },
      rate_limit: { per_minute: 60, burst: 5 },
      tool_rate_limits: { knowledge_search: { per_minute: 30, burst: 5 } },
    },
  ],
};

const text = (value: unknown) => JSON.stringify(value);

describe('parseToolServerConfig', () => {
  it('parses servers, expands env defaults, and defaults timeout_ms', () => {
    const config = parseToolServerConfig(text(SAMPLE), {});
    expect([...config.servers.keys()]).toEqual(['cloud-estate', 'knowledge']);

    const cloud = config.servers.get('cloud-estate')!;
    expect(cloud.auth).toEqual({
      mode: 'static-headers',
      headers: { 'x-acp-broker-credential': 'cloud-estate-dev-broker' },
    });
    expect(cloud.tools.inventory_search).toEqual({ scope: 'cloud:inventory:read', risk: 'R0' });
    expect(cloud.timeout_ms).toBe(15000);

    const knowledge = config.servers.get('knowledge')!;
    expect(knowledge.auth).toEqual({
      mode: 'token-exchange',
      audience: 'acp:knowledge',
      scope: ['knowledge:search:read'],
    });
    expect(knowledge.timeout_ms).toBe(15000); // default applied
    expect(knowledge.tool_rate_limits).toEqual({
      knowledge_search: { per_minute: 30, burst: 5 },
    });
  });

  it('prefers the environment value over the ${VAR:-default}', () => {
    const config = parseToolServerConfig(text(SAMPLE), {
      ACP_TOOL_CRED_CLOUD_ESTATE: 'from-env',
    });
    const cloud = config.servers.get('cloud-estate')!;
    expect(cloud.auth).toMatchObject({ headers: { 'x-acp-broker-credential': 'from-env' } });
  });

  it('throws at startup when a referenced variable has no value and no default', () => {
    const noDefault = structuredClone(SAMPLE);
    noDefault.servers[0]!.auth.headers = { 'x-acp-broker-credential': '${ACP_MISSING_CRED}' };
    expect(() => parseToolServerConfig(text(noDefault), {})).toThrow(
      /ACP_MISSING_CRED is not set and has no default/,
    );
  });

  it('throws on duplicate server ids', () => {
    const dup = structuredClone(SAMPLE);
    dup.servers.push(structuredClone(dup.servers[0]!));
    expect(() => parseToolServerConfig(text(dup), {})).toThrow(/duplicate tool server id/);
  });

  it('rejects a wrong schema marker and an empty server list', () => {
    expect(() => parseToolServerConfig(text({ schema: 'nope', servers: [] }), {})).toThrow(
      /schema must be "acp-tool-servers\/v1"/,
    );
    expect(() =>
      parseToolServerConfig(text({ schema: 'acp-tool-servers/v1', servers: [] }), {}),
    ).toThrow(/non-empty array/);
  });

  it.each([
    ['missing url', (s: typeof SAMPLE) => delete (s.servers[0] as { url?: string }).url, /url/],
    [
      'unknown auth mode',
      (s: typeof SAMPLE) => ((s.servers[0]!.auth as { mode: string }).mode = 'vault'),
      /unknown auth\.mode/,
    ],
    [
      'empty tools map',
      (s: typeof SAMPLE) => ((s.servers[0] as { tools: object }).tools = {}),
      /at least one governed tool/,
    ],
    [
      'tool without scope',
      (s: typeof SAMPLE) => {
        delete (
          (s.servers[0]!.tools as Record<string, { scope?: string }>).inventory_search as {
            scope?: string;
          }
        ).scope;
      },
      /needs a \{scope\}/,
    ],
    [
      'tool without a risk class',
      (s: typeof SAMPLE) => {
        delete (
          (s.servers[0]!.tools as Record<string, { risk?: string }>).inventory_search as {
            risk?: string;
          }
        ).risk;
      },
      /needs a risk class of R0, R1, R2, or R3/,
    ],
    [
      'tool with an invalid risk class',
      (s: typeof SAMPLE) => {
        (s.servers[0]!.tools as Record<string, { risk?: string }>).inventory_search!.risk = 'R9';
      },
      /needs a risk class of R0, R1, R2, or R3/,
    ],
    [
      'bad rate limit',
      (s: typeof SAMPLE) =>
        ((s.servers[0] as { rate_limit: object }).rate_limit = { per_minute: 0 }),
      /positive \{per_minute, burst\}/,
    ],
    [
      'bad timeout',
      (s: typeof SAMPLE) => ((s.servers[0] as { timeout_ms: number }).timeout_ms = -5),
      /timeout_ms must be positive/,
    ],
  ])('rejects %s with an actionable error', (_name, mutate, pattern) => {
    const broken = structuredClone(SAMPLE);
    mutate(broken);
    expect(() => parseToolServerConfig(text(broken), {})).toThrow(pattern);
  });
});

describe('loadToolServerConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-tool-servers-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the file from disk', () => {
    const path = join(dir, 'tool-servers.json');
    writeFileSync(path, text(SAMPLE));
    const config = loadToolServerConfig(path, {});
    expect(config.servers.size).toBe(2);
  });
});

describe('expand', () => {
  it('expands ${VAR}, ${VAR:-default}, and treats empty env values as unset', () => {
    expect(expand('a ${X} b', { X: '1' }, 't')).toBe('a 1 b');
    expect(expand('${X:-fallback}', {}, 't')).toBe('fallback');
    expect(expand('${X:-fallback}', { X: '' }, 't')).toBe('fallback');
    expect(expand('no vars', {}, 't')).toBe('no vars');
    expect(() => expand('${X}', {}, 't')).toThrow(/X is not set/);
  });
});

describe('tool-server catalog loader (SF3)', () => {
  const CRED_ENV = { ACP_TOOL_CRED_CLOUD_ESTATE: 'cloud-estate-secret' };

  const cloudRecord: ToolServerRecord = {
    id: 'cloud-estate',
    url: 'http://localhost:7301/mcp',
    version: '1.0.0',
    owning_team: 'team-platform',
    wrapped_sor: 'cloud-estate',
    data_classification: 'internal',
    auth: {
      mode: 'credential-ref',
      credential_ref: 'ACP_TOOL_CRED_CLOUD_ESTATE',
      header: 'x-acp-broker-credential',
    },
    tools: [
      { name: 'inventory_search', scope: 'cloud:inventory:read', risk: 'R0' },
      { name: 'cost_report', scope: 'cloud:cost:read', risk: 'R0' },
    ],
    rate_limit: { per_minute: 60, burst: 20 },
    timeout_ms: 15000,
  };

  it('maps a credential-ref record to a static-headers entry, expanding the secret from env', () => {
    const entry = recordToEntry(cloudRecord, CRED_ENV);
    expect(entry.auth).toEqual({
      mode: 'static-headers',
      headers: { 'x-acp-broker-credential': 'cloud-estate-secret' },
    });
    expect(entry.tools.inventory_search).toEqual({ scope: 'cloud:inventory:read', risk: 'R0' });
  });

  it('is round-trip identical to the static config for gateway-read fields', () => {
    // The static cloud-estate entry parsed with the SAME broker secret must
    // equal the entry the catalog record yields — the seed→publish→load path
    // is lossless for everything the gateway core reads (parity snapshot).
    const staticEntry = parseToolServerConfig(
      text({
        schema: 'acp-tool-servers/v1',
        servers: [
          {
            id: 'cloud-estate',
            url: 'http://localhost:7301/mcp',
            auth: {
              mode: 'static-headers',
              headers: { 'x-acp-broker-credential': '${ACP_TOOL_CRED_CLOUD_ESTATE}' },
            },
            tools: {
              inventory_search: { scope: 'cloud:inventory:read', risk: 'R0' },
              cost_report: { scope: 'cloud:cost:read', risk: 'R0' },
            },
            rate_limit: { per_minute: 60, burst: 20 },
            timeout_ms: 15000,
          },
        ],
      }),
      CRED_ENV,
    ).servers.get('cloud-estate');
    expect(recordToEntry(cloudRecord, CRED_ENV)).toEqual(staticEntry);
  });

  it('maps a token-exchange record faithfully', () => {
    const entry = recordToEntry(
      {
        ...cloudRecord,
        id: 'knowledge',
        wrapped_sor: 'knowledge',
        auth: {
          mode: 'token-exchange' as const,
          audience: 'acp:knowledge',
          scope: ['knowledge:search:read'],
        },
        tools: [{ name: 'knowledge_search', scope: 'knowledge:search:read', risk: 'R0' as const }],
      },
      CRED_ENV,
    );
    expect(entry.auth).toEqual({
      mode: 'token-exchange',
      audience: 'acp:knowledge',
      scope: ['knowledge:search:read'],
    });
  });

  it('loads a catalog over a stub fetch and builds the server map', async () => {
    const fetchImpl = ((url: string, init: RequestInit) => {
      expect(url).toContain('/v1/tool-servers');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tool_servers: [cloudRecord] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const config = await loadToolServerCatalog({
      registryUrl: 'http://registry',
      token: 'tok',
      env: CRED_ENV,
      fetchImpl,
    });
    expect([...config.servers.keys()]).toEqual(['cloud-estate']);
  });

  it('throws when the registry rejects the catalog read', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ ok: false, status: 403 } as Response)) as unknown as typeof fetch;
    await expect(
      loadToolServerCatalog({
        registryUrl: 'http://registry',
        token: 't',
        env: CRED_ENV,
        fetchImpl,
      }),
    ).rejects.toThrow(/registry:read/);
  });

  it('refuses an empty catalog', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tool_servers: [] }),
      } as unknown as Response)) as unknown as typeof fetch;
    await expect(
      loadToolServerCatalog({
        registryUrl: 'http://registry',
        token: 't',
        env: CRED_ENV,
        fetchImpl,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('drops a sunset server but keeps a deprecated-not-yet-sunset (or sunset-less) one', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();

    // Past sunset → cut. Future sunset → still served. deprecated w/o sunset →
    // advisory, still served.
    const records: ToolServerRecord[] = [
      { ...cloudRecord, id: 'gone', deprecation: { deprecated: true, sunset_at: past } },
      { ...cloudRecord, id: 'soon', deprecation: { deprecated: true, sunset_at: future } },
      { ...cloudRecord, id: 'warned', deprecation: { deprecated: true } },
    ];
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tool_servers: records }),
      } as unknown as Response)) as unknown as typeof fetch;
    const config = await loadToolServerCatalog({
      registryUrl: 'http://registry',
      token: 't',
      env: CRED_ENV,
      fetchImpl,
    });
    expect([...config.servers.keys()].sort()).toEqual(['soon', 'warned']);
  });
});
