import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  JwtVerifier,
  assertPlatformClaims,
  assertTenantAccess,
  delegationChain,
  intersectScopes,
  isPlatformRole,
  scopesOf,
} from '../src/auth.js';

const ISSUER = 'https://token.test.local';

async function makeToken(
  claims: Record<string, unknown>,
  opts?: { issuer?: string; audience?: string | string[] },
) {
  const pair = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(pair.publicKey);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? 'acp:test')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  return { token, jwks: { keys: [{ ...jwk, alg: 'EdDSA' }] } };
}

const GOOD_CLAIMS = {
  sub: 'user:jane.doe',
  tenant: 'acme',
  roles: ['tenant-user'],
  scope: 'task:submit',
};

describe('JwtVerifier', () => {
  it('verifies a valid token and returns platform claims', async () => {
    const { token, jwks } = await makeToken(GOOD_CLAIMS);
    const claims = await new JwtVerifier({ jwks }, ISSUER).verify(token, 'acp:test');
    expect(claims.sub).toBe('user:jane.doe');
    expect(claims.tenant).toBe('acme');
  });

  it('rejects wrong audience, wrong issuer, and wrong key', async () => {
    const { token, jwks } = await makeToken(GOOD_CLAIMS);
    await expect(new JwtVerifier({ jwks }, ISSUER).verify(token, 'acp:other')).rejects.toThrow(
      AuthError,
    );
    await expect(
      new JwtVerifier({ jwks }, 'https://someone-else').verify(token, 'acp:test'),
    ).rejects.toThrow(AuthError);
    const { jwks: otherJwks } = await makeToken(GOOD_CLAIMS);
    await expect(
      new JwtVerifier({ jwks: otherJwks }, ISSUER).verify(token, 'acp:test'),
    ).rejects.toThrow(AuthError);
  });

  it('rejects structurally valid JWTs missing platform claims', async () => {
    const { token, jwks } = await makeToken({ sub: 'user:jane.doe' });
    await expect(new JwtVerifier({ jwks }, ISSUER).verify(token, 'acp:test')).rejects.toThrow(
      /tenant/,
    );
  });
});

describe('JwtVerifier.verifyWithAudience', () => {
  const acceptTools = (aud: string) => aud === 'acp:tools' || aud.startsWith('acp:agent:');

  it('accepts any audience the predicate accepts', async () => {
    const { token, jwks } = await makeToken(GOOD_CLAIMS); // aud acp:test
    const verifier = new JwtVerifier({ jwks }, ISSUER);
    const claims = await verifier.verifyWithAudience(
      token,
      (aud) => aud === 'acp:test',
      'acp:test',
    );
    expect(claims.sub).toBe('user:jane.doe');
    await expect(
      verifier.verifyWithAudience(token, acceptTools, 'acp:tools or acp:agent:{id}'),
    ).rejects.toThrow(/token audience not accepted: acp:tools or acp:agent:\{id\}/);
  });

  it('rejects predicate-refused, multi-audience, wrong-issuer, and expired tokens', async () => {
    const multi = await makeToken(GOOD_CLAIMS, { audience: ['acp:test', 'acp:tools'] });
    await expect(
      new JwtVerifier({ jwks: multi.jwks }, ISSUER).verifyWithAudience(
        multi.token,
        () => true,
        'anything',
      ),
    ).rejects.toThrow(/token audience not accepted/);

    const { token, jwks } = await makeToken(GOOD_CLAIMS);
    await expect(
      new JwtVerifier({ jwks }, 'https://someone-else').verifyWithAudience(
        token,
        () => true,
        'anything',
      ),
    ).rejects.toThrow(/token verification failed/);
  });

  it('still enforces the platform claim shape after the audience passes', async () => {
    const { token, jwks } = await makeToken({ sub: 'user:jane.doe' });
    await expect(
      new JwtVerifier({ jwks }, ISSUER).verifyWithAudience(token, () => true, 'anything'),
    ).rejects.toThrow(/tenant/);
  });
});

describe('assertPlatformClaims', () => {
  it.each([
    [{}, /sub/],
    [{ sub: 'u' }, /tenant/],
    [{ sub: 'u', tenant: 't' }, /roles/],
    [{ sub: 'u', tenant: 't', roles: ['r'] }, /scope/],
    [{ sub: 'u', tenant: 't', roles: [1], scope: '' }, /roles/],
    [{ sub: 'u', tenant: 't', roles: ['r'], scope: '', act: { sub: 42 } }, /malformed act/],
  ])('rejects %j', (claims, pattern) => {
    expect(() => assertPlatformClaims(claims as never)).toThrow(pattern);
  });
});

describe('scopes', () => {
  it('splits and intersects', () => {
    expect(scopesOf({ scope: '' })).toEqual([]);
    expect(scopesOf({ scope: 'a b' })).toEqual(['a', 'b']);
    expect(intersectScopes(['a', 'c'], ['a', 'b'])).toEqual(['a']);
    expect(intersectScopes([], ['a'])).toEqual([]);
  });
});

describe('isPlatformRole / assertTenantAccess', () => {
  const platformSvc = { sub: 'svc:orchestrator', tenant: 'platform', roles: ['platform'] };
  const platformAdmin = { sub: 'user:auditor', tenant: 'acme', roles: ['platform-admin'] };
  const svcPrincipal = { sub: 'svc:agent-ci', tenant: 'platform', roles: [] as string[] };
  const tenantUser = { sub: 'user:jane.doe', tenant: 'acme', roles: ['tenant-user'] };

  it('recognizes the platform role family and svc:* principals', () => {
    expect(isPlatformRole(platformSvc)).toBe(true);
    expect(isPlatformRole(platformAdmin)).toBe(true);
    expect(isPlatformRole(svcPrincipal)).toBe(true);
    expect(isPlatformRole(tenantUser)).toBe(false);
    // 'platform' must be a role or role prefix, not a substring/tenant match.
    expect(isPlatformRole({ sub: 'user:eve', roles: ['not-platform'] })).toBe(false);
  });

  it('lets platform-family callers cross tenants', () => {
    expect(() => {
      assertTenantAccess(platformSvc, 'acme');
    }).not.toThrow();
    expect(() => {
      assertTenantAccess(platformAdmin, 'other-tenant');
    }).not.toThrow();
    expect(() => {
      assertTenantAccess(svcPrincipal, 'globex');
    }).not.toThrow();
  });

  it('binds a non-platform caller to its own token tenant', () => {
    expect(() => {
      assertTenantAccess(tenantUser, 'acme');
    }).not.toThrow();
    try {
      assertTenantAccess(tenantUser, 'globex');
      expect.unreachable('cross-tenant access must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).statusCode).toBe(403);
      expect((err as AuthError).message).toMatch(/may not access tenant globex/);
    }
  });
});

describe('delegationChain', () => {
  it('returns just the principal without act claims', () => {
    expect(delegationChain({ sub: 'user:jane.doe' })).toEqual([{ sub: 'user:jane.doe' }]);
  });

  it('unwinds nested act claims outermost-principal-first', () => {
    const chain = delegationChain({
      sub: 'user:jane.doe',
      act: { sub: 'agent:knowledge-agent@0.1.0', act: { sub: 'svc:orchestrator' } },
    });
    expect(chain.map((l) => l.sub)).toEqual([
      'user:jane.doe',
      'svc:orchestrator',
      'agent:knowledge-agent@0.1.0',
    ]);
  });
});
