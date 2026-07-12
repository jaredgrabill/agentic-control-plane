import type { AgentManifest, StepRequest } from '@acp/protocol';

/** Port of the Python SDK tests' conftest.py MANIFEST. */
export const MANIFEST: AgentManifest = {
  id: 'test-agent',
  name: 'Test Agent',
  owner: 'team-tests',
  description: 'SDK unit-test agent.',
  capabilities: [
    {
      name: 'test.echo',
      description: 'Echoes input as a cited answer.',
      risk: 'R0',
      input_schema: { type: 'object' },
      output_schema: {
        type: 'object',
        required: ['text', 'citations', 'confidence'],
        properties: {
          text: { type: 'string' },
          citations: { type: 'array' },
          confidence: { type: 'number' },
          abstained: { type: 'boolean' },
        },
      },
      examples: [{ input: {} }, { input: {} }, { input: {} }],
    },
  ],
};

export function stepRequest(overrides: Partial<StepRequest> = {}): StepRequest {
  return {
    kind: 'step_request',
    step_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f44',
    task_id: '0197a3b0-6c1e-7d3a-8f4b-2f9c1d2e3f40',
    tenant: 'acme',
    agent_id: 'test-agent',
    capability: 'test.echo',
    input: { text: 'hello' },
    ...overrides,
  };
}

export function goodOutput(text = 'hello [1]'): Record<string, unknown> {
  return { text, citations: [], confidence: 0.9 };
}
