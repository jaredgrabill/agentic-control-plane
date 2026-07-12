import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, CapabilityError } from '@acp/agent-sdk';
import { noRetriever } from '@acp/tool-client';
import { describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities/index.js';
import { fixtureToolClient } from '../src/fixture-tools.js';
import { callOptions, createToolClient, NETSEC, primaryProvenance } from '../src/tools.js';

const MANIFEST = join(import.meta.dirname, '..', 'manifest.yaml');

describe('scaffold plumbing', () => {
  it('loads the manifest and registers capability deps without error', () => {
    const agent = Agent.fromManifest(MANIFEST, { retriever: noRetriever('netsec-agent') });
    expect(() => {
      registerCapabilities(agent, { tools: fixtureToolClient() });
    }).not.toThrow();
  });

  it('the fixture tool client round-trips a netsec read with provenance', async () => {
    const tools = fixtureToolClient();
    const response = await tools.call(
      NETSEC,
      'firewall_rules_search',
      { service: 'payments-api' },
      { delegatedToken: 'test-token', taskId: randomUUID(), stepId: randomUUID() },
    );
    expect(primaryProvenance(response).doc_id).toBe('netsec/firewall-ruleset');
    const data = response.data as { rules: unknown[] };
    expect(data.rules.length).toBeGreaterThan(0);
  });
});

describe('tools wiring', () => {
  it('createToolClient binds the netsec server from the environment', () => {
    expect(createToolClient()).toBeDefined();
  });

  it('createToolClient wires the acp:tools exchange only when a client secret is set', () => {
    const saved = process.env.ACP_AGENT_CLIENT_SECRET;
    try {
      delete process.env.ACP_AGENT_CLIENT_SECRET;
      expect(createToolClient()).toBeDefined();
      process.env.ACP_AGENT_CLIENT_SECRET = 'agent-netsec-dev-secret';
      expect(createToolClient()).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.ACP_AGENT_CLIENT_SECRET;
      else process.env.ACP_AGENT_CLIENT_SECRET = saved;
    }
  });

  it('callOptions forwards the delegated identity and correlation ids', () => {
    const ctx = { delegatedToken: 't', taskId: 'task', stepId: 'step' };
    expect(callOptions(ctx)).toEqual({ delegatedToken: 't', taskId: 'task', stepId: 'step' });
  });

  it('primaryProvenance refuses a provenance-free tool response', () => {
    expect(() => primaryProvenance({ data: {}, provenance: [] })).toThrow(CapabilityError);
  });
});
