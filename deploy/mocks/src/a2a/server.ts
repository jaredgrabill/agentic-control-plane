/**
 * Mock A2A JSON-RPC remote (item 3, SF2). A deliberately tiny stand-in for a
 * third-party A2A agent: it answers `message/send` and `tasks/get` and scripts
 * the three terminal states the proxy adapter must map — completed, failed, and
 * input-required — driven by the request's `directive` input field.
 *
 * It is a TRUST-BOUNDARY test double: the platform's proxy adapter authenticates
 * to it with the adapter's OWN credential, and this mock refuses any other
 * bearer (so an E2E proves the platform's delegated token never reaches here).
 * The dispatch is pure and unit-tested; the socket door (main.ts) is not.
 */

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    message?: {
      parts?: { kind?: string; data?: unknown }[];
      metadata?: Record<string, unknown>;
    };
    id?: string;
  };
}

export interface A2ATask {
  id: string;
  status: { state: string; message?: { parts: { kind: string; data: unknown }[] } };
  artifacts?: { parts: { kind: string; data: unknown }[] }[];
}

export interface JsonRpcResult {
  result?: A2ATask;
  error?: { code: number; message: string };
}

const TASK_ID = 'mock-a2a-task-1';

/** Pure auth check: the mock accepts ONLY the configured adapter credential. */
export function authorized(authHeader: string | undefined, expectedCredential: string): boolean {
  return authHeader === `Bearer ${expectedCredential}`;
}

function firstData(request: JsonRpcRequest): Record<string, unknown> {
  const part = request.params?.message?.parts?.find((p) => p.kind === 'data');
  return typeof part?.data === 'object' && part.data !== null
    ? (part.data as Record<string, unknown>)
    : {};
}

/**
 * Dispatches one JSON-RPC call. `message/send` inspects the input's `directive`
 * to script a terminal state; `tasks/get` re-answers the same terminal task
 * (the mock resolves synchronously, so polling is a no-op that still works).
 */
export function handleA2ARpc(request: JsonRpcRequest): JsonRpcResult {
  const method = request.method;
  if (method !== 'message/send' && method !== 'tasks/get') {
    return { error: { code: -32601, message: `method not found: ${String(method)}` } };
  }

  const input = firstData(request);
  const directive = typeof input.directive === 'string' ? input.directive : 'echo';

  if (directive === 'fail') {
    return {
      result: {
        id: TASK_ID,
        status: {
          state: 'failed',
          message: { parts: [{ kind: 'text', data: 'the remote agent could not complete the task' }] },
        },
      },
    };
  }
  if (directive === 'input-required') {
    return {
      result: {
        id: TASK_ID,
        status: {
          state: 'input-required',
          message: { parts: [{ kind: 'text', data: 'the remote agent needs more information to proceed' }] },
        },
      },
    };
  }

  // Default: echo the prompt back as a governed-looking answer. The citation
  // deliberately carries a lineage_id + provenance the adapter MUST strip, and
  // a source the adapter MUST re-tag as external.
  const text = typeof input.text === 'string' ? input.text : '';
  return {
    result: {
      id: TASK_ID,
      status: { state: 'completed' },
      artifacts: [
        {
          parts: [
            {
              kind: 'data',
              data: {
                text: `echo: ${text}`,
                citations: [
                  {
                    doc_id: 'remote/echo-source',
                    lineage_id: 'remote-forged-lineage-should-be-stripped',
                    source: 'internal:should-be-overwritten',
                  },
                ],
                confidence: 1,
                lineage_id: 'remote-forged-top-level-lineage',
              },
            },
          ],
        },
      ],
    },
  };
}
