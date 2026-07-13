import type { NatsConnection } from 'nats';
import { describe, expect, it } from 'vitest';
import {
  assertFlaggableRisk,
  assertTenantId,
  KillSwitchControl,
  KillSwitchWatcher,
  createLogger,
  tenantOfKillSwitchKey,
} from '../src/index.js';

/** Minimal fake KV: records puts and replays a scripted watch stream. */
interface Entry {
  key: string;
  operation: 'PUT' | 'DEL' | 'PURGE';
  string(): string;
}

function ncWith(kv: unknown): NatsConnection {
  return {
    jetstream: () => ({ views: { kv: () => Promise.resolve(kv) } }),
  } as unknown as NatsConnection;
}

const flush = () => new Promise((r) => setImmediate(r));

/** Mirrors the module's KV key derivation: base64url of the principal (KV forbids : and @). */
const principalKey = (sub: string): string =>
  `killswitch.principal.${Buffer.from(sub, 'utf8').toString('base64url')}`;

describe('KillSwitchControl principal denylist', () => {
  it('writes and clears the base64url-encoded principal key (KV forbids : and @)', async () => {
    const puts: [string, string][] = [];
    const nc = ncWith({ put: (k: string, v: string) => (puts.push([k, v]), Promise.resolve(1)) });
    const control = await KillSwitchControl.open(nc);
    const key = principalKey('agent:cloud-agent@0.1.0');
    // The stored key must be a valid NATS KV key: no ':' or '@'.
    expect(key).not.toMatch(/[:@]/);

    await control.denyPrincipal('agent:cloud-agent@0.1.0', 'compromised', 'svc:agent-ci');
    expect(puts[0]![0]).toBe(key);
    expect(JSON.parse(puts[0]![1])).toMatchObject({
      active: true,
      reason: 'compromised',
      activated_by: 'svc:agent-ci',
    });

    await control.allowPrincipal('agent:cloud-agent@0.1.0');
    expect(puts[1]![0]).toBe(key);
    expect(JSON.parse(puts[1]![1])).toEqual({ active: false });
  });
});

describe('KillSwitchWatcher principal denylist', () => {
  it('answers principalDenied from the control-KV stream, active-only', async () => {
    async function* entries(): AsyncGenerator<Entry> {
      await Promise.resolve();
      yield {
        key: principalKey('user:bob'),
        operation: 'PUT',
        string: () => JSON.stringify({ active: true, reason: 'x' }),
      };
      yield {
        key: principalKey('user:alice'),
        operation: 'PUT',
        string: () => JSON.stringify({ active: false }),
      };
      yield {
        key: 'killswitch.agent.cloud-agent',
        operation: 'PUT',
        string: () => JSON.stringify({ active: true }),
      };
    }
    const nc = ncWith({ watch: () => Promise.resolve(entries()) });
    const watcher = await KillSwitchWatcher.start(nc, createLogger('killswitch-test'));
    await flush();

    // Active denylist entry → truthy; a cleared one → undefined.
    expect(watcher.principalDenied('user:bob')).toBeDefined();
    expect(watcher.principalDenied('user:alice')).toBeUndefined();
    // The denylist is keyed by full principal, distinct from agent suspension.
    expect(watcher.principalDenied('cloud-agent')).toBeUndefined();
    expect(watcher.agentSuspension('cloud-agent')).toBeDefined();
    watcher.stop();
  });
});

describe('KillSwitchControl capability and risk flags', () => {
  it('writes the KV-legal capability key and refuses R0 as a risk target', async () => {
    const puts: [string, string][] = [];
    const nc = ncWith({ put: (k: string, v: string) => (puts.push([k, v]), Promise.resolve(1)) });
    const control = await KillSwitchControl.open(nc);

    await control.suspendCapability('change.submit', 'bad drafts', 'user:ops');
    expect(puts[0]![0]).toBe('killswitch.capability.change.submit');
    expect(puts[0]![0]).not.toMatch(/[:@]/);
    expect(JSON.parse(puts[0]![1])).toMatchObject({ active: true, reason: 'bad drafts' });

    await control.suspendRiskClass('R2', 'estate incident', 'user:ops');
    expect(puts[1]![0]).toBe('killswitch.risk.R2');

    await control.reinstateCapability('change.submit');
    expect(JSON.parse(puts[2]![1])).toEqual({ active: false });

    await expect(control.suspendRiskClass('R0', 'x', 'y')).rejects.toThrow(
      /cannot be kill-switched/,
    );
    expect(() => {
      assertFlaggableRisk('R0');
    }).toThrow(/R0 is read-only/);
    expect(() => {
      assertFlaggableRisk('R2');
    }).not.toThrow();
  });
});

describe('assertTenantId', () => {
  it('accepts KV-legal tenant ids and rejects everything else', () => {
    expect(assertTenantId('acme')).toBe('acme');
    expect(assertTenantId('globex')).toBe('globex');
    expect(assertTenantId('acme-corp-eu')).toBe('acme-corp-eu');
    for (const bad of ['a.b', 'a:b', 'a@b', '*', 'acp.>', 'Acme', '', 'a b', 'a/b']) {
      expect(() => assertTenantId(bad), bad).toThrow(/not valid/);
    }
  });

  it('maps kill-switch keys back to tenants (and only tenant keys)', () => {
    expect(tenantOfKillSwitchKey('killswitch.tenant.globex')).toBe('globex');
    expect(tenantOfKillSwitchKey('killswitch.fleet')).toBeUndefined();
    expect(tenantOfKillSwitchKey('killswitch.agent.globex')).toBeUndefined();
    // A structurally invalid trailing token is never a tenant.
    expect(tenantOfKillSwitchKey('killswitch.tenant.')).toBeUndefined();
    expect(tenantOfKillSwitchKey('killswitch.tenant.a.b')).toBeUndefined();
  });
});

describe('KillSwitchControl tenant halt', () => {
  it('writes and clears killswitch.tenant.{tenant}, refusing invalid tenant ids', async () => {
    const puts: [string, string][] = [];
    const nc = ncWith({ put: (k: string, v: string) => (puts.push([k, v]), Promise.resolve(1)) });
    const control = await KillSwitchControl.open(nc);

    await control.haltTenant('globex', 'incident drill', 'user:ops');
    expect(puts[0]![0]).toBe('killswitch.tenant.globex');
    expect(JSON.parse(puts[0]![1])).toMatchObject({
      active: true,
      reason: 'incident drill',
      activated_by: 'user:ops',
    });

    await control.resumeTenant('globex');
    expect(puts[1]![0]).toBe('killswitch.tenant.globex');
    expect(JSON.parse(puts[1]![1])).toEqual({ active: false });

    // A crafted tenant can never reach the KV (wildcards, other families).
    await expect(control.haltTenant('a.b', 'x', 'y')).rejects.toThrow(/not valid/);
    await expect(control.resumeTenant('fleet.')).rejects.toThrow(/not valid/);
    expect(puts).toHaveLength(2);
  });
});

describe('KillSwitchWatcher tenant halt', () => {
  it('answers tenantHalt per tenant, active-only, and enumerates active halts', async () => {
    async function* entries(): AsyncGenerator<Entry> {
      await Promise.resolve();
      yield {
        key: 'killswitch.tenant.globex',
        operation: 'PUT',
        string: () => JSON.stringify({ active: true, reason: 'drill' }),
      };
      yield {
        key: 'killswitch.tenant.acme',
        operation: 'PUT',
        string: () => JSON.stringify({ active: false }),
      };
      yield {
        key: 'killswitch.fleet',
        operation: 'PUT',
        string: () => JSON.stringify({ active: true }),
      };
    }
    const nc = ncWith({ watch: () => Promise.resolve(entries()) });
    const watcher = await KillSwitchWatcher.start(nc, createLogger('killswitch-test'));
    await flush();

    expect(watcher.tenantHalt('globex')?.reason).toBe('drill');
    expect(watcher.tenantHalt('acme')).toBeUndefined();
    // Blocks exactly one tenant: another tenant is untouched.
    expect(watcher.tenantHalt('initech')).toBeUndefined();
    // The fleet key is a different tier — never a tenant halt.
    expect([...watcher.activeTenantHalts().keys()]).toEqual(['globex']);
    // An invalid tenant is refused, not silently un-halted.
    expect(() => watcher.tenantHalt('a.b')).toThrow(/not valid/);
    watcher.stop();
  });
});

describe('KillSwitchWatcher capability and risk flags', () => {
  it('answers named + monotonic risk suspensions and fires onFlip', async () => {
    const flips: [string, boolean][] = [];
    async function* entries(): AsyncGenerator<Entry> {
      await Promise.resolve();
      yield {
        key: 'killswitch.capability.change.submit',
        operation: 'PUT',
        string: () => JSON.stringify({ active: true, reason: 'named' }),
      };
      yield {
        key: 'killswitch.risk.R2',
        operation: 'PUT',
        string: () => JSON.stringify({ active: true, reason: 'risk' }),
      };
    }
    const nc = ncWith({ watch: () => Promise.resolve(entries()) });
    const watcher = await KillSwitchWatcher.start(nc, createLogger('killswitch-test'));
    watcher.onFlip((key, state) => flips.push([key, state?.active === true]));
    await flush();
    await flush();

    // Named capability suspension.
    expect(watcher.capabilitySuspension('change.submit')).toBeDefined();
    expect(watcher.capabilitySuspension('change.draft')).toBeUndefined();

    // Monotonic risk: R2 flag blocks R2 and R3, NOT R1/R0.
    expect(watcher.riskClassSuspension('R2')).toBeDefined();
    expect(watcher.riskClassSuspension('R3')).toBeDefined();
    expect(watcher.riskClassSuspension('R1')).toBeUndefined();
    expect(watcher.riskClassSuspension('R0')).toBeUndefined();

    // capabilityHalt combines named-first then risk.
    expect(watcher.capabilityHalt('change.draft', 'R2')?.reason).toBe('risk');
    expect(watcher.capabilityHalt('change.submit', 'R0')?.reason).toBe('named');

    // onFlip saw at least the risk PUT (registered after history may miss earlier).
    expect(flips.some(([k, active]) => k === 'killswitch.risk.R2' && active)).toBe(true);
    watcher.stop();
  });
});
