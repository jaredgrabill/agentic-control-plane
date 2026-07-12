import { describe, expect, it } from 'vitest';
import { AuthError, type PlatformClaims } from '@acp/service-kit';
import { acceptLlmAudience, resolveCaller } from '../src/caller.js';

function claimsFor(overrides: Partial<PlatformClaims>): PlatformClaims {
  return {
    sub: 'svc:agent-ci',
    aud: 'acp:llm',
    tenant: 'platform',
    roles: ['platform'],
    scope: 'llm:invoke',
    ...overrides,
  };
}

describe('acceptLlmAudience', () => {
  it('accepts acp:llm and any acp:agent:{id}, nothing else', () => {
    expect(acceptLlmAudience('acp:llm')).toBe(true);
    expect(acceptLlmAudience('acp:agent:cloud-agent')).toBe(true);
    expect(acceptLlmAudience('acp:tools')).toBe(false);
    expect(acceptLlmAudience('acp:gateway')).toBe(false);
  });
});

describe('resolveCaller', () => {
  it('resolves a service caller holding llm:invoke', () => {
    const caller = resolveCaller(claimsFor({}));
    expect(caller.principal).toBe('svc:agent-ci');
    expect(caller.agentId).toBeUndefined();
    expect(caller.scopes).toEqual(['llm:invoke']);
  });

  it('refuses an acp:llm service token without llm:invoke', () => {
    expect(() => resolveCaller(claimsFor({ scope: 'registry:read' }))).toThrow(AuthError);
    expect(() => resolveCaller(claimsFor({ scope: '' }))).toThrow(/lacks the llm:invoke scope/);
  });

  it('accepts an agent-audience token whose actor matches, keyed for allowlist + kill switch', () => {
    const caller = resolveCaller(
      claimsFor({
        sub: 'user:jane.doe',
        aud: 'acp:agent:cloud-agent',
        tenant: 'acme',
        scope: '',
        act: { sub: 'agent:cloud-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
      }),
    );
    expect(caller.principal).toBe('agent:cloud-agent@0.1.0');
    expect(caller.agentId).toBe('cloud-agent');
    expect(caller.sub).toBe('user:jane.doe');
  });

  it('refuses an agent audience whose act.sub names a different agent (aud↔actor)', () => {
    expect(() =>
      resolveCaller(
        claimsFor({
          aud: 'acp:agent:cloud-agent',
          act: { sub: 'agent:code-agent@0.1.0' },
        }),
      ),
    ).toThrow(/does not match its actor/);
  });

  it('refuses an agent audience with no act chain at all (a re-aimed bare token)', () => {
    expect(() => resolveCaller(claimsFor({ aud: 'acp:agent:cloud-agent' }))).toThrow(AuthError);
  });

  it('derives the agent id from an agent principal on acp:llm without requiring llm:invoke', () => {
    const caller = resolveCaller(
      claimsFor({
        sub: 'user:jane.doe',
        scope: '',
        act: { sub: 'agent:knowledge-agent@0.1.0' },
      }),
    );
    expect(caller.agentId).toBe('knowledge-agent');
  });
});
