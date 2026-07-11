import { AuthError, type PlatformClaims } from '@acp/service-kit';
import { describe, expect, it } from 'vitest';
import { acceptToolsAudience, resolveCaller } from '../src/caller.js';

function claims(overrides: Partial<PlatformClaims> = {}): PlatformClaims {
  return {
    sub: 'user:jane.doe',
    aud: 'acp:tools',
    tenant: 'acme',
    roles: ['tenant-user'],
    scope: 'knowledge:search:read task:submit',
    ...overrides,
  };
}

describe('acceptToolsAudience', () => {
  it.each([
    ['acp:tools', true],
    ['acp:agent:cloud-agent', true],
    ['acp:agent:', true],
    ['acp:gateway', false],
    ['acp:knowledge', false],
    ['', false],
  ])('%s → %s', (aud, expected) => {
    expect(acceptToolsAudience(aud)).toBe(expected);
  });
});

describe('resolveCaller', () => {
  it('resolves a plain user token: principal is the sub, no agent id', () => {
    const caller = resolveCaller(claims(), 'raw-token');
    expect(caller).toMatchObject({
      sub: 'user:jane.doe',
      principal: 'user:jane.doe',
      entityType: 'User',
      tenant: 'acme',
      scopes: ['knowledge:search:read', 'task:submit'],
      token: 'raw-token',
    });
    expect(caller.agentId).toBeUndefined();
  });

  it('resolves an agent-audience delegated token: acting agent is the principal', () => {
    const caller = resolveCaller(
      claims({
        aud: 'acp:agent:cloud-agent',
        scope: 'cloud:inventory:read cloud:cost:read',
        act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
      }),
      'raw-token',
    );
    expect(caller).toMatchObject({
      sub: 'user:jane.doe',
      principal: 'agent:cloud-agent@0.1.0',
      entityType: 'Agent',
      agentId: 'cloud-agent',
    });
  });

  it('refuses an agent audience whose act.sub names a different agent', () => {
    expect(() =>
      resolveCaller(
        claims({
          aud: 'acp:agent:cloud-agent',
          act: { sub: 'agent:code-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
        }),
        't',
      ),
    ).toThrow(AuthError);
  });

  it('refuses an agent audience with no act chain at all (stolen bare token shape)', () => {
    expect(() => resolveCaller(claims({ aud: 'acp:agent:cloud-agent' }), 't')).toThrow(
      /does not match its actor/,
    );
  });

  it('derives the agent id from the principal for acp:tools agent tokens (kill-switch key)', () => {
    const caller = resolveCaller(
      claims({ aud: 'acp:tools', act: { sub: 'agent:code-agent@0.1.0' } }),
      't',
    );
    expect(caller.entityType).toBe('Agent');
    expect(caller.agentId).toBe('code-agent');
  });

  it('classifies service principals', () => {
    const caller = resolveCaller(claims({ sub: 'svc:ci', scope: '' }), 't');
    expect(caller.entityType).toBe('Service');
    expect(caller.scopes).toEqual([]);
  });
});
