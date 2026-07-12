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
    // Phase 3 flip: the agent audience family is no longer accepted.
    ['acp:agent:cloud-agent', false],
    ['acp:agent:', false],
    ['acp:gateway', false],
    ['acp:knowledge', false],
    ['', false],
  ])('%s → %s', (aud, expected) => {
    expect(acceptToolsAudience(aud)).toBe(expected);
  });
});

describe('resolveCaller', () => {
  it('resolves a plain user token: principal is the sub, no agent id, no chain required', () => {
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

  it('resolves an agent tools token whose chain terminates at the orchestrator', () => {
    const caller = resolveCaller(
      claims({
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

  it('refuses an agent-principal token with no delegation chain at all', () => {
    expect(() => resolveCaller(claims({ sub: 'agent:cloud-agent@0.1.0' }), 't')).toThrow(
      /no delegation chain terminating at svc:orchestrator/,
    );
  });

  it('refuses an agent-principal token whose chain does not bottom out at the orchestrator', () => {
    // A fabricated chain: agent acting for a user, but no broker hop —
    // the shape an agent secret + stolen user token would forge.
    expect(() => resolveCaller(claims({ act: { sub: 'agent:cloud-agent@0.1.0' } }), 't')).toThrow(
      AuthError,
    );
    expect(() =>
      resolveCaller(
        claims({ act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:some-other' } } }),
        't',
      ),
    ).toThrow(/svc:orchestrator/);
  });

  it('accepts a deep chain as long as its innermost actor is the orchestrator', () => {
    const caller = resolveCaller(
      claims({
        act: {
          sub: 'agent:code-agent@0.1.0',
          act: { sub: 'agent:planner@0.1.0', act: { sub: 'svc:orchestrator' } },
        },
      }),
      't',
    );
    expect(caller.entityType).toBe('Agent');
    expect(caller.agentId).toBe('code-agent');
  });

  it('exempts user and service principals from the orchestrator-chain check', () => {
    // IDE users mint acp:tools directly (Cedar gates them); no chain.
    const user = resolveCaller(claims({ sub: 'user:jane.doe' }), 't');
    expect(user.entityType).toBe('User');
    const svc = resolveCaller(claims({ sub: 'svc:ci', scope: '' }), 't');
    expect(svc.entityType).toBe('Service');
    expect(svc.scopes).toEqual([]);
  });
});
