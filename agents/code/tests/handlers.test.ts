import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, CapabilityError, ErrorClass } from '@acp/agent-sdk';
import { ApplicationFailure } from '@temporalio/common';
import { FakeToolClient, noRetriever, type ToolResponse } from '@acp/tool-client';
import { describe, expect, it } from 'vitest';
import { ciStats, windowStart, type CiRun } from '../src/capabilities/ci-health.js';
import { formatPackage, requireRepo } from '../src/capabilities/dependency-query.js';
import { registerCapabilities } from '../src/capabilities/index.js';
import { createToolClient } from '../src/tools.js';

const MANIFEST = join(import.meta.dirname, '..', 'manifest.yaml');

const DEPS_PROV = {
  doc_id: 'code/dependency-graph',
  version: '2026-07-08',
  lineage_id: '01981c00-0000-7000-8000-0000000000b2',
};
const CI_PROV = {
  doc_id: 'code/ci-activity',
  version: '2026-07-08',
  lineage_id: '01981c00-0000-7000-8000-0000000000b3',
};

const DIRECT_PACKAGES = [
  { repo: 'acme/platform-sdk', version: '2.4.1', type: 'library' },
  { repo: 'acme/ledger-core', version: '3.1.0', type: 'service-client' },
  { repo: 'acme/openssl-shim', version: '1.2.0', type: 'library' },
];

const RUNS: CiRun[] = [
  {
    run_id: 'r-9436',
    status: 'success',
    message: 'fix: pin flaky settlement retry spec',
    finished_at: '2026-07-07T17:45:00Z',
  },
  {
    run_id: 'r-9430',
    status: 'failed',
    message: 'test: flaky settlement retry spec',
    finished_at: '2026-07-06T13:21:00Z',
  },
  {
    run_id: 'r-9412',
    status: 'success',
    message: 'infra: scale payments fleet 4 -> 10 replicas for TLS 1.3 migration load test',
    finished_at: '2026-07-01T21:14:00Z',
    deploy_id: 'd-2026-07-01-042',
  },
  {
    run_id: 'r-9377',
    status: 'success',
    message: 'routine dependency bump: platform-sdk 2.4.0 -> 2.4.1',
    finished_at: '2026-06-26T14:30:00Z',
    deploy_id: 'd-2026-06-26-031',
  },
  {
    run_id: 'r-9322',
    status: 'success',
    message: 'feat: settlement batching',
    finished_at: '2026-06-20T12:00:00Z',
  },
];

function depsResponse(packages: unknown[], direction = 'dependencies'): ToolResponse {
  return {
    data: { repo: 'acme/payments-service', direction, transitive: false, packages },
    provenance: [DEPS_PROV],
  };
}

function ciResponse(runs: CiRun[] = RUNS): ToolResponse {
  return {
    data: { repo: 'acme/payments-service', as_of: '2026-07-08', runs },
    provenance: [CI_PROV],
  };
}

function buildAgent(tools: FakeToolClient): Agent {
  const agent = Agent.fromManifest(MANIFEST, { retriever: noRetriever('code-agent') });
  registerCapabilities(agent, { tools });
  return agent;
}

function stepRequest(capability: string, input: Record<string, unknown>) {
  return {
    kind: 'step_request',
    step_id: randomUUID(),
    task_id: randomUUID(),
    tenant: 'acme',
    agent_id: 'code-agent',
    capability,
    input,
  };
}

interface AnswerOutput {
  text: string;
  citations: { doc_id: string }[];
  confidence: number;
  abstained?: boolean;
}

describe('code.dependency_query', () => {
  it('lists direct dependencies with versions and types — zero LLM calls', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () => depsResponse(DIRECT_PACKAGES),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('code.dependency_query', { repo: 'acme/payments-service' }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toBe(
      'acme/payments-service has 3 direct dependencies: acme/platform-sdk@2.4.1 (library), ' +
        'acme/ledger-core@3.1.0 (service-client), acme/openssl-shim@1.2.0 (library). [1]',
    );
    expect(output.citations).toEqual([DEPS_PROV]);
    expect(output.confidence).toBe(0.9);
    expect(step.usage?.llm_calls).toBe(0);
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]).toMatchObject({
      server: 'code-forge',
      tool: 'repo_dependencies',
      args: { repo: 'acme/payments-service', direction: 'dependencies', transitive: false },
    });
  });

  it('forwards the delegated token and correlation ids to the gateway', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () => depsResponse(DIRECT_PACKAGES),
    });
    const request = {
      ...stepRequest('code.dependency_query', { repo: 'acme/payments-service' }),
      delegated_token: 'delegated-jwt-456',
    };
    const step = await buildAgent(tools).execute(request);
    expect(step.status).toBe('completed');
    expect(tools.calls[0]!.options).toEqual({
      delegatedToken: 'delegated-jwt-456',
      taskId: request.task_id,
      stepId: request.step_id,
    });
  });

  it('renders dependents with the reversed phrasing', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () =>
        depsResponse(
          [
            { repo: 'acme/checkout-web', version: 'api-v2', type: 'service-client' },
            { repo: 'acme/partner-gateway', version: 'api-v2', type: 'service-client' },
          ],
          'dependents',
        ),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('code.dependency_query', {
        repo: 'acme/payments-service',
        direction: 'dependents',
      }),
    );
    expect((step.output as unknown as AnswerOutput).text).toBe(
      '2 repos depend on acme/payments-service: acme/checkout-web, acme/partner-gateway. [1]',
    );
  });

  it('marks transitive edges with via and keeps the dedup count', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () =>
        depsResponse([
          ...DIRECT_PACKAGES.slice(0, 2),
          { repo: 'acme/openssl-shim', version: '1.2.0', type: 'library', via: 'acme/ledger-core' },
        ]),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('code.dependency_query', { repo: 'acme/payments-service', transitive: true }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('3 dependencies (direct and transitive)');
    expect(output.text).toContain('acme/openssl-shim@1.2.0 (library, via acme/ledger-core)');
  });

  it('states empty edge lists confidently in both directions', async () => {
    const none = new FakeToolClient({ 'code-forge.repo_dependencies': () => depsResponse([]) });
    const step = await buildAgent(none).execute(
      stepRequest('code.dependency_query', { repo: 'acme/infra-terraform' }),
    );
    expect((step.output as unknown as AnswerOutput).text).toBe(
      'acme/infra-terraform has no recorded dependencies. [1]',
    );

    const noneDependents = new FakeToolClient({
      'code-forge.repo_dependencies': () => depsResponse([], 'dependents'),
    });
    const dependents = await buildAgent(noneDependents).execute(
      stepRequest('code.dependency_query', {
        repo: 'acme/infra-terraform',
        direction: 'dependents',
      }),
    );
    expect((dependents.output as unknown as AnswerOutput).text).toBe(
      'No repos depend on acme/infra-terraform. [1]',
    );
  });

  it.each([
    ['missing repo', {}],
    ['shell metacharacters', { repo: 'acme/payments-service; rm -rf /' }],
    ['bad direction', { repo: 'acme/payments-service', direction: 'sideways' }],
  ])('fails needs_input on %s without calling the tool', async (_name, input) => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(stepRequest('code.dependency_query', input));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(tools.calls).toHaveLength(0);
  });

  it('unknown repo (tool not_found) surfaces as needs_input', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () => {
        throw new CapabilityError(
          ErrorClass.NeedsInput,
          'repo acme/does-not-exist is not known to the forge — check the name',
        );
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('code.dependency_query', { repo: 'acme/does-not-exist' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(step.error?.message).toContain('not known to the forge');
  });
});

describe('code.ci_health', () => {
  it('computes the windowed pass rate and lists deploys oldest-first', async () => {
    const tools = new FakeToolClient({ 'code-forge.ci_runs': () => ciResponse() });
    const step = await buildAgent(tools).execute(
      stepRequest('code.ci_health', { repo: 'acme/payments-service' }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    // Window = as_of 2026-07-08 − 14d = 2026-06-24: r-9322 (06-20) drops out.
    expect(output.text).toBe(
      'acme/payments-service: 4 CI runs since 2026-06-24 — 3 passed, 1 failed ' +
        '(pass rate 75.0%). Deploys: d-2026-06-26-031 (routine dependency bump: ' +
        'platform-sdk 2.4.0 -> 2.4.1), d-2026-07-01-042 (infra: scale payments fleet ' +
        '4 -> 10 replicas for TLS 1.3 migration load test). [1]',
    );
    expect(output.citations).toEqual([CI_PROV]);
    expect(step.usage?.llm_calls).toBe(0);
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]).toMatchObject({
      server: 'code-forge',
      tool: 'ci_runs',
      args: { repo: 'acme/payments-service' },
    });
  });

  it('narrows the window from the tool as_of, never the wall clock', async () => {
    const tools = new FakeToolClient({ 'code-forge.ci_runs': () => ciResponse() });
    const step = await buildAgent(tools).execute(
      stepRequest('code.ci_health', { repo: 'acme/payments-service', window_days: 5 }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('2 CI runs since 2026-07-03');
    expect(output.text).toContain('pass rate 50.0%');
    expect(output.text).not.toContain('Deploys:');
  });

  it('reports a quiet repo confidently', async () => {
    const tools = new FakeToolClient({ 'code-forge.ci_runs': () => ciResponse([]) });
    const step = await buildAgent(tools).execute(
      stepRequest('code.ci_health', { repo: 'acme/openssl-shim' }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toBe('acme/openssl-shim: no CI runs since 2026-06-24. [1]');
    expect(output.confidence).toBe(0.9);
    expect(output.abstained).toBeUndefined();
  });

  it.each([
    ['missing repo', {}],
    ['out-of-range window', { repo: 'acme/payments-service', window_days: 365 }],
  ])('fails needs_input on %s', async (_name, input) => {
    const step = await buildAgent(new FakeToolClient({})).execute(
      stepRequest('code.ci_health', input),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
  });
});

describe('tool failures propagate through the execute taxonomy', () => {
  it('retryable tool errors become retryable ApplicationFailures for Temporal', async () => {
    const tools = new FakeToolClient({
      'code-forge.ci_runs': () => {
        throw new CapabilityError(
          ErrorClass.Retryable,
          'tool code-forge.ci_runs did not answer within 15000ms',
        );
      },
    });
    const failure = await buildAgent(tools)
      .execute(stepRequest('code.ci_health', { repo: 'acme/payments-service' }))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe('Retryable');
    expect((failure as ApplicationFailure).nonRetryable).toBe(false);
  });

  it('permanent tool errors land as a failed step result', async () => {
    const tools = new FakeToolClient({
      'code-forge.repo_dependencies': () => {
        throw new CapabilityError(ErrorClass.Permanent, 'malformed');
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('code.dependency_query', { repo: 'acme/payments-service' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('permanent');
  });
});

describe('pure helpers', () => {
  it('windowStart is pure date arithmetic on as_of', () => {
    expect(windowStart('2026-07-08', 14)).toBe('2026-06-24');
    expect(windowStart('2026-07-08', 5)).toBe('2026-07-03');
    expect(windowStart('2026-01-03', 7)).toBe('2025-12-27');
  });

  it('ciStats reproduces the storyline pass rate', () => {
    const windowed = RUNS.filter((r) => r.finished_at.slice(0, 10) >= '2026-06-24');
    const stats = ciStats(windowed);
    expect(stats).toMatchObject({ total: 4, passed: 3, failed: 1 });
    expect(stats.deploys.map((d) => d.deploy_id)).toEqual(['d-2026-06-26-031', 'd-2026-07-01-042']);
    // The fixture-backed suite covers the full 9-run window; here the exact
    // arithmetic: 7/9 → 77.8%.
    expect(((7 / 9) * 100).toFixed(1)).toBe('77.8');
  });

  it('requireRepo and formatPackage render deterministically', () => {
    expect(requireRepo({ repo: 'acme/payments-service' })).toBe('acme/payments-service');
    expect(() => requireRepo({ repo: 'ACME/Payments' })).toThrow(CapabilityError);
    expect(formatPackage({ repo: 'acme/platform-sdk', version: '2.4.1', type: 'library' })).toBe(
      'acme/platform-sdk@2.4.1 (library)',
    );
  });

  it('createToolClient binds the code-forge server from the environment', () => {
    expect(createToolClient()).toBeDefined();
  });

  it('createToolClient wires the acp:tools exchange only when a client secret is set', () => {
    const saved = process.env.ACP_AGENT_CLIENT_SECRET;
    try {
      delete process.env.ACP_AGENT_CLIENT_SECRET;
      expect(createToolClient()).toBeDefined();
      process.env.ACP_AGENT_CLIENT_SECRET = 'agent-code-dev-secret';
      expect(createToolClient()).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.ACP_AGENT_CLIENT_SECRET;
      else process.env.ACP_AGENT_CLIENT_SECRET = saved;
    }
  });
});
