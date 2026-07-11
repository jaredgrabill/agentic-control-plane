import { describe, expect, it } from 'vitest';
import {
  ciRuns,
  createForgeServer,
  loadForgeFixtures,
  repoDependencies,
  type CiRun,
} from '../src/index.js';
import { callTool, FIXTURES_DIR } from './support.js';

const fx = loadForgeFixtures(FIXTURES_DIR);

interface PackageRef {
  repo: string;
  version: string;
  type: string;
  via?: string;
}

function okData(outcome: ReturnType<typeof repoDependencies>): Record<string, unknown> {
  expect(outcome.kind).toBe('ok');
  return (outcome as { kind: 'ok'; data: Record<string, unknown> }).data;
}

describe('repoDependencies', () => {
  it('lists direct dependencies in edge order', () => {
    const data = okData(repoDependencies(fx, { repo: 'acme/payments-service' }));
    expect(data.packages).toEqual([
      { repo: 'acme/platform-sdk', version: '2.4.1', type: 'library' },
      { repo: 'acme/ledger-core', version: '3.1.0', type: 'service-client' },
      { repo: 'acme/openssl-shim', version: '1.2.0', type: 'library' },
    ]);
    expect(data.direction).toBe('dependencies');
    expect(data.transitive).toBe(false);
  });

  it('transitive BFS dedups the platform-sdk edge shared via ledger-core', () => {
    const data = okData(repoDependencies(fx, { repo: 'acme/payments-service', transitive: true }));
    const packages = data.packages as PackageRef[];
    // ledger-core → platform-sdk@2.4.1 is already present as a direct edge:
    // the walk keeps the first (shortest) path, so the count stays 3.
    expect(packages).toHaveLength(3);
    expect(packages.filter((p) => p.repo === 'acme/platform-sdk')).toHaveLength(1);
    expect(packages.find((p) => p.repo === 'acme/platform-sdk')?.via).toBeUndefined();
  });

  it('transitive walk marks second-hop edges with via', () => {
    const data = okData(repoDependencies(fx, { repo: 'acme/checkout-web', transitive: true }));
    const packages = data.packages as PackageRef[];
    const ledger = packages.find((p) => p.repo === 'acme/ledger-core');
    expect(ledger?.via).toBe('acme/payments-service');
  });

  it('lists dependents (reverse edges)', () => {
    const data = okData(
      repoDependencies(fx, { repo: 'acme/payments-service', direction: 'dependents' }),
    );
    expect((data.packages as PackageRef[]).map((p) => p.repo).sort()).toEqual([
      'acme/checkout-web',
      'acme/partner-gateway',
    ]);
  });

  it('returns an empty list for a repo with no edges', () => {
    const data = okData(repoDependencies(fx, { repo: 'acme/infra-terraform' }));
    expect(data.packages).toEqual([]);
  });

  it('unknown repo is a typed not_found', () => {
    expect(repoDependencies(fx, { repo: 'acme/ghost' })).toEqual({
      kind: 'not_found',
      message: 'repo acme/ghost is not known to the forge — check the name',
    });
  });
});

describe('ciRuns', () => {
  it('returns the repo runs newest first with the snapshot as_of', () => {
    const data = okData(ciRuns(fx, { repo: 'acme/payments-service' }));
    const runs = data.runs as CiRun[];
    expect(data.as_of).toBe('2026-07-08');
    expect(runs).toHaveLength(10);
    expect(runs[0]!.run_id).toBe('r-9436');
    expect(runs.at(-1)!.run_id).toBe('r-9322');
  });

  it('windows by since/until dates (inclusive)', () => {
    const data = okData(
      ciRuns(fx, { repo: 'acme/payments-service', since: '2026-06-24', until: '2026-07-01' }),
    );
    const runs = data.runs as CiRun[];
    expect(runs.map((r) => r.run_id)).toEqual(['r-9412', 'r-9401', 'r-9384', 'r-9377', 'r-9350']);
  });

  it('a known repo with zero runs answers ok with an empty list', () => {
    const data = okData(ciRuns(fx, { repo: 'acme/openssl-shim' }));
    expect(data.runs).toEqual([]);
  });

  it('rejects inverted windows and unknown repos with typed outcomes', () => {
    expect(
      ciRuns(fx, { repo: 'acme/payments-service', since: '2026-07-01', until: '2026-06-01' }),
    ).toEqual({
      kind: 'invalid_input',
      message: 'since 2026-07-01 is after until 2026-06-01',
    });
    expect(ciRuns(fx, { repo: 'acme/ghost' }).kind).toBe('not_found');
  });
});

describe('code-forge MCP round trips', () => {
  it('serves envelopes with the dependency-graph provenance', async () => {
    const result = await callTool(createForgeServer(fx), 'repo_dependencies', {
      repo: 'acme/payments-service',
    });
    expect(result.isError).toBe(false);
    const envelope = result.structuredContent as {
      ok: boolean;
      provenance: { doc_id: string }[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.provenance).toEqual([fx.dependencies.document]);
  });

  it('serves ci_runs with the ci-activity provenance and honors the failure directive', async () => {
    const healthy = await callTool(createForgeServer(fx), 'ci_runs', {
      repo: 'acme/payments-service',
    });
    expect(
      (healthy.structuredContent as { provenance: { doc_id: string }[] }).provenance[0]!.doc_id,
    ).toBe('code/ci-activity');

    const limited = createForgeServer(fx, { failure: { kind: 'rate_limited', retryAfterS: 2 } });
    const result = await callTool(limited, 'ci_runs', { repo: 'acme/payments-service' });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { retry_after_s: number } }).error.retry_after_s,
    ).toBe(2);
  });
});
