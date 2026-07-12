import { createRequire } from 'node:module';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundle } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentWorkflow } from '../src/workflows.js';
import {
  CONTROL_TASK_QUEUE,
  type ControlActivities,
  type DeploymentConfig,
  type DeploymentPreflight,
  type GateReport,
} from '../src/types.js';

const CONFIG: DeploymentConfig = {
  shadow_soak_s: 1,
  min_shadow_samples: 2,
  ramp_steps: [5, 50, 100],
  ramp_soak_s: 1,
  drain_s: 1,
  thresholds: {
    max_success_delta: 0.05,
    max_p95_ratio: 1.5,
    max_cost_ratio: 1.25,
    min_shadow_completion: 0.9,
    min_shadow_samples: 2,
    max_quality_delta: 0.1,
    min_quality_samples: 2,
  },
};

const pass = (): GateReport => ({
  verdict: 'pass',
  samples: { candidate: 5, incumbent: 20 },
  metrics: { success_ratio: 1 },
  reasons: [],
});
const fail = (): GateReport => ({
  verdict: 'fail',
  samples: { candidate: 5, incumbent: 20 },
  metrics: { success_ratio: 0.5 },
  reasons: ['breach'],
});

const audited: Record<string, unknown>[] = [];
const control: ControlActivities = {
  snapshotPrincipal: vi.fn(),
  planTask: vi.fn(),
  discoverAgent: vi.fn(),
  resolveRoute: vi.fn(),
  checkKillSwitch: vi.fn(),
  authorizeDelegation: vi.fn(),
  brokerToken: vi.fn(),
  digestApprovalSubject: vi.fn().mockResolvedValue({ subject_digest: `sha256:${'a'.repeat(64)}` }),
  emitAudit: vi.fn((e: Record<string, unknown>) => {
    audited.push(e);
    return Promise.resolve();
  }),
  digestValue: vi.fn().mockResolvedValue({ digest: `sha256:${'0'.repeat(64)}` }),
  getPriceBook: vi.fn(),
  beginDeployment: vi.fn(),
  deployTransition: vi.fn().mockResolvedValue(undefined),
  promoteVersion: vi.fn().mockResolvedValue(undefined),
  evaluateGate: vi.fn(),
  scoreWithJudge: vi.fn(() => Promise.resolve()),
  mintProbeSubject: vi.fn(),
  recordProbeResult: vi.fn(() => Promise.resolve({ passed: true })),
  listProbeTargets: vi.fn(() => Promise.resolve({ uncovered: [] })),
  checkQualityFreeze: vi.fn(() => Promise.resolve({ frozen: false })),
  now: vi.fn().mockResolvedValue({ iso: '2026-07-11T10:00:00Z' }),
};

const preflight = (over: Partial<DeploymentPreflight> = {}): DeploymentPreflight => ({
  incumbentVersion: '0.1.0',
  capabilities: ['knowledge.search'],
  requiresApproval: false,
  baselineNote: 'comparable_suite',
  ...over,
});

const request = () => ({
  deployment_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e4000',
  agent_id: 'knowledge-agent',
  candidate_version: '0.2.0',
  initiated_by: 'svc:ci',
  tenant: 'acme',
  config: CONFIG,
});

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;
const require = createRequire(import.meta.url);

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: require.resolve('../src/workflows.ts'),
  });
}, 240_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(() => {
  audited.length = 0;
  vi.mocked(control.beginDeployment).mockReset().mockResolvedValue(preflight());
  vi.mocked(control.deployTransition).mockReset().mockResolvedValue(undefined);
  vi.mocked(control.promoteVersion).mockReset().mockResolvedValue(undefined);
  vi.mocked(control.now).mockReset().mockResolvedValue({ iso: '2026-07-11T10:00:00Z' });
  vi.mocked(control.digestValue)
    .mockReset()
    .mockResolvedValue({ digest: `sha256:${'0'.repeat(64)}` });
  vi.mocked(control.evaluateGate).mockReset();
});

async function run(): Promise<{ status: string; reason: string }> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    taskQueue: CONTROL_TASK_QUEUE,
    workflowBundle,
    activities: { ...control },
  });
  return worker.runUntil(
    env.client.workflow.execute(DeploymentWorkflow, {
      taskQueue: CONTROL_TASK_QUEUE,
      workflowId: `deploy-test-${Math.random().toString(36).slice(2)}`,
      args: [request()],
    }),
  );
}

const types = (): string[] => audited.map((e) => e.event_type as string);

describe('DeploymentWorkflow', () => {
  it('shadow → full ramp → promote → complete, zero manual routing', async () => {
    vi.mocked(control.evaluateGate).mockResolvedValue(pass());
    const result = await run();
    expect(result.status).toBe('completed');
    // Candidate: shadow, canary@5, @50, @100, then incumbent retired.
    expect(vi.mocked(control.deployTransition).mock.calls.map((c) => c[0].state)).toEqual([
      'shadow',
      'canary',
      'canary',
      'canary',
      'retired',
    ]);
    expect(vi.mocked(control.promoteVersion)).toHaveBeenCalledWith({
      agentId: 'knowledge-agent',
      version: '0.2.0',
    });
    expect(types()).toEqual([
      'deployment.started',
      'deployment.ramped',
      'deployment.ramped',
      'deployment.ramped',
      'deployment.promoted',
      'deployment.completed',
    ]);
  });

  it('a failed shadow gate fails the deployment, leaving the candidate in shadow', async () => {
    vi.mocked(control.evaluateGate).mockResolvedValue(fail());
    const result = await run();
    expect(result.status).toBe('failed');
    // Only the shadow transition ran — no ramp.
    expect(vi.mocked(control.deployTransition).mock.calls.map((c) => c[0].state)).toEqual([
      'shadow',
    ]);
    expect(types()).toEqual(['deployment.started', 'deployment.failed']);
  });

  it('re-soaks once on insufficient shadow data, then fails honestly', async () => {
    vi.mocked(control.evaluateGate)
      .mockResolvedValueOnce({ ...pass(), verdict: 'insufficient_data' })
      .mockResolvedValueOnce({ ...pass(), verdict: 'insufficient_data' });
    const result = await run();
    expect(result.status).toBe('failed');
    expect(vi.mocked(control.evaluateGate)).toHaveBeenCalledTimes(2);
  });

  it('a breach at the first ramp step demotes to shadow', async () => {
    vi.mocked(control.evaluateGate)
      .mockResolvedValueOnce(pass()) // shadow
      .mockResolvedValue(fail()); // canary@5 breach
    const result = await run();
    expect(result.status).toBe('demoted');
    expect(types()).toEqual([
      'deployment.started',
      'deployment.ramped',
      'deployment.demoted',
      'deployment.failed',
    ]);
    // Last transition demotes back to shadow.
    const states = vi.mocked(control.deployTransition).mock.calls.map((c) => c[0].state);
    expect(states.at(-1)).toBe('shadow');
  });

  it('rolls back one step on a mid-ramp breach, then resumes to completion', async () => {
    // shadow pass, @5 pass, @50 BREACH (rollback to 5), @5 pass, @50 pass, @100 pass.
    vi.mocked(control.evaluateGate)
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(pass());
    const result = await run();
    expect(result.status).toBe('completed');
    expect(types()).toContain('deployment.rolled_back');
    expect(types().at(-1)).toBe('deployment.completed');
  });

  it('demotes on two consecutive breaches', async () => {
    // shadow pass, @5 pass, @50 breach (rollback), @5 breach again → 2 consecutive → demote.
    vi.mocked(control.evaluateGate)
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(fail());
    const result = await run();
    expect(result.status).toBe('demoted');
    expect(types()).toContain('deployment.rolled_back');
    expect(types().at(-1)).toBe('deployment.failed');
  });

  it('a first-ever deployment (no incumbent) promotes without a retire', async () => {
    // No incumbent: omit incumbentVersion entirely (exactOptionalPropertyTypes).
    vi.mocked(control.beginDeployment).mockResolvedValue({
      capabilities: ['knowledge.search'],
      requiresApproval: false,
      baselineNote: 'no incumbent baseline to compare',
    });
    vi.mocked(control.evaluateGate).mockResolvedValue(pass());
    const result = await run();
    expect(result.status).toBe('completed');
    const states = vi.mocked(control.deployTransition).mock.calls.map((c) => c[0].state);
    expect(states).not.toContain('retired');
  });
});
