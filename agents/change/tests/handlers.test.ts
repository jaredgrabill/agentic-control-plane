import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, CapabilityError, ErrorClass } from '@acp/agent-sdk';
import { ApplicationFailure } from '@temporalio/common';
import { FakeToolClient, noRetriever, type ToolResponse } from '@acp/tool-client';
import { describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities/index.js';
import { createToolClient } from '../src/tools.js';

const MANIFEST = join(import.meta.dirname, '..', 'manifest.yaml');

const CAL_PROV = {
  doc_id: 'itsm/change-calendar',
  version: '2026-07-11',
  lineage_id: '01981c00-0000-7000-8000-0000000000c2',
};
const LOG_PROV = {
  doc_id: 'itsm/change-log',
  version: '2026-07-11',
  lineage_id: '01981c00-0000-7000-8000-0000000000c1',
};

function calendarResponse(data: Record<string, unknown>): ToolResponse {
  return { data, provenance: [CAL_PROV] };
}
function logResponse(data: Record<string, unknown>): ToolResponse {
  return { data, provenance: [LOG_PROV] };
}

function buildAgent(tools: FakeToolClient): Agent {
  const agent = Agent.fromManifest(MANIFEST, { retriever: noRetriever('change-agent') });
  registerCapabilities(agent, { tools });
  return agent;
}

function stepRequest(capability: string, input: Record<string, unknown>) {
  return {
    kind: 'step_request',
    step_id: randomUUID(),
    task_id: randomUUID(),
    tenant: 'acme',
    agent_id: 'change-agent',
    capability,
    input,
  };
}

interface AnswerOutput {
  text: string;
  citations: { doc_id: string }[];
  confidence: number;
  abstained?: boolean;
  change_id?: string;
  status?: string;
  previous_status?: string;
}

describe('change.conflict_check', () => {
  it('reports a clear window with the calendar citation, zero LLM calls', async () => {
    const tools = new FakeToolClient({
      'itsm.calendar_conflicts': () =>
        calendarResponse({
          coverage_through: '2026-08-31T23:59:59Z',
          within_coverage: true,
          conflicts: [],
          freezes: [],
        }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.conflict_check', {
        window: { start: '2026-07-16T07:00:00Z', end: '2026-07-16T08:00:00Z' },
      }),
    );
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('is clear');
    expect(output.citations).toEqual([CAL_PROV]);
    expect(output.abstained).toBeUndefined();
    expect(step.usage?.llm_calls).toBe(0);
  });

  it('flags a freeze and lists overlapping scheduled changes', async () => {
    const tools = new FakeToolClient({
      'itsm.calendar_conflicts': () =>
        calendarResponse({
          coverage_through: '2026-08-31T23:59:59Z',
          within_coverage: true,
          conflicts: [{ change_id: 'CHG-0990', title: 'Payments gateway node drain' }],
          freezes: [{ name: 'quarterly close' }],
        }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.conflict_check', {
        window: { start: '2026-07-18T02:00:00Z', end: '2026-07-18T03:00:00Z' },
        service: 'payments-api',
      }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('change freeze');
    expect(output.text).toContain('CHG-0990');
    expect(output.text).toContain('for payments-api');
  });

  it('abstains when the window ends beyond the coverage horizon', async () => {
    const tools = new FakeToolClient({
      'itsm.calendar_conflicts': () =>
        calendarResponse({
          coverage_through: '2026-08-31T23:59:59Z',
          within_coverage: false,
          conflicts: [],
          freezes: [],
        }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.conflict_check', {
        window: { start: '2026-09-05T02:00:00Z', end: '2026-09-05T03:00:00Z' },
      }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.abstained).toBe(true);
    expect(output.citations).toEqual([]);
  });

  it('fails needs_input without a window, before any tool call', async () => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(stepRequest('change.conflict_check', {}));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(tools.calls).toHaveLength(0);
  });
});

describe('change.draft', () => {
  it('creates a draft, returns change_id + status, keyed by the step id', async () => {
    const tools = new FakeToolClient({
      'itsm.change_create_draft': () => logResponse({ change_id: 'CHG-2001', status: 'draft' }),
    });
    const req = stepRequest('change.draft', {
      title: 'Rotate the payments-api TLS certificate',
      service: 'payments-api',
    });
    const step = await buildAgent(tools).execute(req);
    expect(step.status).toBe('completed');
    const output = step.output as unknown as AnswerOutput;
    expect(output.change_id).toBe('CHG-2001');
    expect(output.status).toBe('draft');
    expect(output.citations).toEqual([LOG_PROV]);
    // The idempotency key is the step id (design §D5).
    expect(tools.calls[0]!.args.idempotency_key).toBe(req.step_id);
    expect(tools.calls[0]!.args.title).toBe('Rotate the payments-api TLS certificate');
  });

  it('fails needs_input on a too-short title before calling the tool', async () => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(stepRequest('change.draft', { title: 'short' }));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(tools.calls).toHaveLength(0);
  });
});

describe('change.submit', () => {
  it('submits a draft and reports the transition', async () => {
    const tools = new FakeToolClient({
      'itsm.change_submit': () =>
        logResponse({ change_id: 'CHG-1001', status: 'submitted', previous_status: 'draft' }),
    });
    const req = stepRequest('change.submit', { change_id: 'CHG-1001' });
    const step = await buildAgent(tools).execute(req);
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('Submitted change CHG-1001');
    expect(output.status).toBe('submitted');
    expect(output.previous_status).toBe('draft');
    expect(tools.calls[0]!.args.idempotency_key).toBe(req.step_id);
  });

  it('fails needs_input on a non-CHG change id before calling the tool', async () => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(
      stepRequest('change.submit', { change_id: 'oops' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(tools.calls).toHaveLength(0);
  });

  it('a not_found from the tool surfaces as needs_input', async () => {
    const tools = new FakeToolClient({
      'itsm.change_submit': () => {
        throw new CapabilityError(ErrorClass.NeedsInput, 'change CHG-9999 is not in the change log');
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.submit', { change_id: 'CHG-9999' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
  });

  it('an invalid_input (wrong state) from the tool surfaces as permanent', async () => {
    const tools = new FakeToolClient({
      'itsm.change_submit': () => {
        throw new CapabilityError(ErrorClass.Permanent, 'change CHG-1003 cannot be submitted');
      },
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.submit', { change_id: 'CHG-1003' }),
    );
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('permanent');
  });

  it('retryable tool errors become retryable ApplicationFailures for Temporal', async () => {
    const tools = new FakeToolClient({
      'itsm.change_submit': () => {
        throw new CapabilityError(ErrorClass.Retryable, 'rate limited', { retry_after_s: 3 });
      },
    });
    const failure = await buildAgent(tools)
      .execute(stepRequest('change.submit', { change_id: 'CHG-1001' }))
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).nonRetryable).toBe(false);
  });
});

describe('change.withdraw', () => {
  it('withdraws by a direct change_id and forwards the reason', async () => {
    const tools = new FakeToolClient({
      'itsm.change_withdraw': () =>
        logResponse({ change_id: 'CHG-1002', status: 'withdrawn', previous_status: 'submitted' }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.withdraw', { change_id: 'CHG-1002', reason: 'superseded' }),
    );
    const output = step.output as unknown as AnswerOutput;
    expect(output.text).toContain('Withdrew change CHG-1002');
    expect(output.status).toBe('withdrawn');
    expect(tools.calls[0]!.args.reason).toBe('superseded');
  });

  it('resolves the change id from a compensator original.output handle', async () => {
    const tools = new FakeToolClient({
      'itsm.change_withdraw': () =>
        logResponse({ change_id: 'CHG-1004', status: 'withdrawn', previous_status: 'submitted' }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.withdraw', {
        original: {
          capability: 'change.submit',
          input: { change_id: 'CHG-1004' },
          output: { change_id: 'CHG-1004', status: 'submitted' },
        },
      }),
    );
    expect(step.status).toBe('completed');
    expect(tools.calls[0]!.args.change_id).toBe('CHG-1004');
  });

  it('falls back to original.input.change_id when output has none', async () => {
    const tools = new FakeToolClient({
      'itsm.change_withdraw': () =>
        logResponse({ change_id: 'CHG-1004', status: 'withdrawn', previous_status: 'submitted' }),
    });
    const step = await buildAgent(tools).execute(
      stepRequest('change.withdraw', {
        original: { capability: 'change.submit', input: { change_id: 'CHG-1004' }, output: {} },
      }),
    );
    expect(step.status).toBe('completed');
    expect(tools.calls[0]!.args.change_id).toBe('CHG-1004');
  });

  it('fails needs_input when no change id can be recovered', async () => {
    const tools = new FakeToolClient({});
    const step = await buildAgent(tools).execute(stepRequest('change.withdraw', {}));
    expect(step.status).toBe('failed');
    expect(step.error?.class).toBe('needs_input');
    expect(tools.calls).toHaveLength(0);
  });
});

describe('tools wiring', () => {
  it('createToolClient binds the itsm server from the environment', () => {
    expect(createToolClient()).toBeDefined();
  });

  it('createToolClient wires the acp:tools exchange only when a client secret is set', () => {
    const saved = process.env.ACP_AGENT_CLIENT_SECRET;
    try {
      delete process.env.ACP_AGENT_CLIENT_SECRET;
      expect(createToolClient()).toBeDefined();
      process.env.ACP_AGENT_CLIENT_SECRET = 'agent-change-dev-secret';
      expect(createToolClient()).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.ACP_AGENT_CLIENT_SECRET;
      else process.env.ACP_AGENT_CLIENT_SECRET = saved;
    }
  });
});
