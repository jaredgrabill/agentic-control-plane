import type { NatsConnection } from 'nats';
import { describe, expect, it } from 'vitest';
import { KillSwitchControl, KillSwitchWatcher, createLogger } from '../src/index.js';

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
