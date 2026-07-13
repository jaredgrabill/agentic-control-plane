/**
 * Minimal A2A v1.0 JSON-RPC client for the proxy adapter (item 3, SF2):
 * message/send + tasks/get polling until a terminal state, with a per-remote
 * wall-clock timeout.
 *
 * TRUST BOUNDARY: everything this client SENDS is the mapped capability
 * input plus the adapter's OWN remote credential — never the platform's
 * broker delegated token (the adapter never reads it). Everything it
 * RECEIVES is untrusted; callers map states to typed outcomes and sanitize
 * outputs before they re-enter the platform.
 */

import { randomUUID } from 'node:crypto';

/** Terminal A2A task states the adapter maps to step outcomes. */
export const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'rejected',
  'canceled',
  'input-required',
  'auth-required',
]);

/** The adapter's view of a finished (terminal) remote task. */
export interface A2ATaskView {
  state: string;
  /** First structured data payload of the task's artifacts/status message. */
  output: Record<string, unknown>;
  /** Remote-supplied status text, if any (untrusted, for diagnostics only). */
  message?: string | undefined;
}

export interface A2ASendRequest {
  capability: string;
  input: Record<string, unknown>;
  taskId: string;
  stepId: string;
}

/** Remote transport/protocol failure — retryable at the orchestration layer. */
export class A2ATransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2ATransportError';
  }
}

/** The remote did not reach a terminal state inside the adapter's window. */
export class A2ATimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2ATimeoutError';
  }
}

export interface A2AClientOptions {
  endpoint: string;
  /** The adapter's OWN credential for the remote — never a platform token. */
  credential: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface A2ATask {
  id?: string;
  status?: { state?: string; message?: A2AMessage };
  artifacts?: { parts?: A2APart[] }[];
}

interface A2AMessage {
  parts?: A2APart[];
}

interface A2APart {
  kind?: string;
  data?: unknown;
}

export class A2AClient {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: A2AClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Sends one capability invocation and resolves at a terminal task state. */
  async send(request: A2ASendRequest): Promise<A2ATaskView> {
    const deadline = Date.now() + this.timeoutMs;
    let task = await this.rpc('message/send', {
      message: {
        role: 'user',
        messageId: randomUUID(),
        parts: [{ kind: 'data', data: request.input }],
        metadata: {
          capability: request.capability,
          task_id: request.taskId,
          step_id: request.stepId,
        },
      },
    });

    while (!TERMINAL_STATES.has(stateOf(task))) {
      if (Date.now() > deadline) {
        throw new A2ATimeoutError(
          `remote a2a task did not reach a terminal state within ${this.timeoutMs}ms`,
        );
      }
      if (typeof task.id !== 'string' || task.id === '') {
        throw new A2ATransportError('remote returned a non-terminal task without an id to poll');
      }
      await this.sleep(this.pollIntervalMs);
      task = await this.rpc('tasks/get', { id: task.id });
    }

    return {
      state: stateOf(task),
      output: firstDataPart(task),
      message: statusText(task),
    };
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<A2ATask> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The adapter's OWN remote credential — the only secret that ever
          // crosses to the remote.
          authorization: `Bearer ${this.opts.credential}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      });
    } catch (err) {
      throw new A2ATransportError(
        `a2a remote unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new A2ATransportError(`a2a remote answered http ${res.status}`);
    }
    let body: JsonRpcResponse;
    try {
      body = (await res.json()) as JsonRpcResponse;
    } catch {
      throw new A2ATransportError('a2a remote answered non-json');
    }
    if (body.error !== undefined) {
      throw new A2ATransportError(
        `a2a remote error ${String(body.error.code ?? '')}: ${body.error.message ?? 'unknown'}`,
      );
    }
    return (body.result as A2ATask | undefined) ?? {};
  }
}

function stateOf(task: A2ATask): string {
  return typeof task.status?.state === 'string' ? task.status.state : '';
}

/** First `data` part across artifacts, then the status message — else {}. */
function firstDataPart(task: A2ATask): Record<string, unknown> {
  const parts: A2APart[] = [
    ...(task.artifacts ?? []).flatMap((a) => a.parts ?? []),
    ...(task.status?.message?.parts ?? []),
  ];
  for (const part of parts) {
    if (part.kind === 'data' && typeof part.data === 'object' && part.data !== null) {
      return part.data as Record<string, unknown>;
    }
  }
  return {};
}

function statusText(task: A2ATask): string | undefined {
  const parts = task.status?.message?.parts ?? [];
  for (const part of parts) {
    if (part.kind === 'text' && typeof part.data === 'string') return part.data;
  }
  return undefined;
}
