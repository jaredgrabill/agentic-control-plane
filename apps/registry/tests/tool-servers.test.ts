import { toolServerRecord } from '@acp/protocol';
import { describe, expect, it } from 'vitest';
import { staticServersToRecords } from '../src/tool-servers.js';

const STATIC = {
  schema: 'acp-tool-servers/v1',
  servers: [
    {
      id: 'cloud-estate',
      url: 'http://localhost:7301/mcp',
      auth: {
        mode: 'static-headers',
        headers: { 'x-acp-broker-credential': '${ACP_TOOL_CRED_CLOUD_ESTATE:-cloud-estate-dev-broker}' },
      },
      tools: {
        inventory_search: { scope: 'cloud:inventory:read', risk: 'R0' },
        tag_apply: { scope: 'cloud:tag:write', risk: 'R2' },
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
    },
  ],
};

describe('staticServersToRecords', () => {
  it('converts static-headers auth to a credential-ref with the env KEY NAME only', () => {
    const [cloud] = staticServersToRecords(STATIC);
    expect(cloud?.auth).toEqual({
      mode: 'credential-ref',
      credential_ref: 'ACP_TOOL_CRED_CLOUD_ESTATE',
      header: 'x-acp-broker-credential',
    });
    // The secret / default fallback is never carried into the catalog.
    expect(JSON.stringify(cloud)).not.toContain('cloud-estate-dev-broker');
  });

  it('preserves tools with scope + risk and converts token-exchange auth', () => {
    const [, knowledge] = staticServersToRecords(STATIC);
    expect(knowledge?.auth).toEqual({
      mode: 'token-exchange',
      audience: 'acp:knowledge',
      scope: ['knowledge:search:read'],
    });
    expect(knowledge?.tools).toEqual([
      { name: 'knowledge_search', scope: 'knowledge:search:read', risk: 'R0' },
    ]);
  });

  it('produces records that validate against the protocol schema', () => {
    for (const record of staticServersToRecords(STATIC)) {
      expect(() => toolServerRecord.parse(record)).not.toThrow();
    }
  });

  it('rejects a static-headers credential that is not a ${VAR} reference', () => {
    expect(() =>
      staticServersToRecords({
        servers: [
          {
            id: 'bad',
            url: 'http://x/mcp',
            auth: { mode: 'static-headers', headers: { 'x-acp-broker-credential': 'literal-secret' } },
            tools: { t: { scope: 'a:b:read', risk: 'R0' } },
            rate_limit: { per_minute: 1, burst: 1 },
          },
        ],
      }),
    ).toThrow(/VAR/);
  });
});
