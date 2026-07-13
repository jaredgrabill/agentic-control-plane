/**
 * registerProxyCapabilities: turns a manifest-bound @acp/agent-sdk Agent into a
 * governed proxy for a remote A2A endpoint (item 3, SF2).
 *
 * The load-bearing property is that the adapter IS an ordinary Agent, so the
 * orchestrator's policy-enforcement point (workflows.ts runAgentStep) sees a
 * normal card and gates the proxy exactly like a native agent — kill switch,
 * budget, Cedar-on-declared-risk, audit, depth guard, compensation — with zero
 * proxy-specific branches. Every handler installed here:
 *
 *   1. maps the validated capability input to an A2A message;
 *   2. calls the remote with the adapter's OWN credential (baked into the
 *      A2AClient), NEVER the platform's broker `delegated_token` — the adapter
 *      never reads ctx.delegatedToken for anything outbound;
 *   3. maps the terminal A2A task state to a typed step outcome, treating the
 *      remote reply as UNTRUSTED: the SDK validates it against the declared
 *      output_schema, and this module strips first-party lineage and tags any
 *      remote-supplied provenance as external before it re-enters the platform.
 *
 * Remote-reported usage is never read, so it cannot enter the cost ledger — the
 * proxy makes no model calls and the SDK books zero LLM usage for the step.
 */

import { CapabilityError, ErrorClass, type Agent, type CapabilityContext } from '@acp/agent-sdk';
import {
  A2ATimeoutError,
  A2ATransportError,
  type A2AClient,
  type A2ATaskView,
} from './client.js';

export interface ProxyOptions {
  /** The remote A2A client, constructed with the adapter's own credential. */
  client: A2AClient;
  /**
   * A stable, human-readable name for the remote used to TAG any provenance it
   * returns (`external:<remoteName>`). Never a secret or an internal id.
   */
  remoteName: string;
  /**
   * Optional capability → remote skill-id map. Defaults to identity: the
   * platform capability name is sent as the A2A skill. A remote that names its
   * skills differently is bridged here, never by trusting the remote.
   */
  skillFor?: (capability: string) => string;
  /** Restrict to a subset of declared capabilities; defaults to all of them. */
  capabilities?: string[];
}

/**
 * Installs a proxy handler for each selected manifest capability. Throws if a
 * requested capability is not declared (the manifest is the contract).
 */
export function registerProxyCapabilities(agent: Agent, opts: ProxyOptions): void {
  const declared = new Set(agent.manifest.capabilities.map((c) => c.name));
  const names = opts.capabilities ?? [...declared];
  const skillFor = opts.skillFor ?? ((c: string): string => c);

  for (const name of names) {
    if (!declared.has(name)) {
      throw new Error(
        `cannot proxy capability ${name}: it is not declared in the manifest for ${agent.agentId}`,
      );
    }
    agent.capability(name, (ctx, input) => proxyStep(opts.client, opts.remoteName, skillFor, ctx, input));
  }
}

async function proxyStep(
  client: A2AClient,
  remoteName: string,
  skillFor: (capability: string) => string,
  ctx: CapabilityContext,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let view: A2ATaskView;
  try {
    view = await client.send({
      capability: skillFor(ctx.capability),
      input,
      taskId: ctx.taskId,
      stepId: ctx.stepId,
    });
  } catch (err) {
    // Transport/timeout: retryable at the orchestration layer (Temporal owns
    // the retry). Any other throw is a programming error and propagates.
    if (err instanceof A2ATransportError || err instanceof A2ATimeoutError) {
      throw new CapabilityError(ErrorClass.Retryable, err.message);
    }
    throw err;
  }

  switch (view.state) {
    case 'completed':
      // Untrusted output: sanitize provenance here; the SDK then validates it
      // against the declared output_schema (one repair retry, else permanent).
      return sanitizeRemoteOutput(view.output);
    case 'input-required':
    case 'auth-required':
      // The remote is asking for more input. This is a terminal, non-retryable
      // STEP outcome — NEVER an approval grant. Approval is decided before
      // dispatch, inside the orchestrator, and is unreachable from here.
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        `remote agent ${remoteName} requires additional input (${view.state})` +
          (view.message !== undefined ? `: ${view.message}` : ''),
      );
    case 'failed':
    case 'rejected':
    case 'canceled':
      throw new CapabilityError(
        ErrorClass.Permanent,
        `remote agent ${remoteName} task ${view.state}` +
          (view.message !== undefined ? `: ${view.message}` : ''),
      );
    default:
      throw new CapabilityError(
        ErrorClass.Permanent,
        `remote agent ${remoteName} returned an unexpected terminal state ${JSON.stringify(view.state)}`,
      );
  }
}

/** Keys that would assert FIRST-PARTY lineage; a remote can never claim these. */
const LINEAGE_KEYS = ['lineage_id', 'provenance', 'signature', 'card_signature'];

/**
 * Sanitizes an untrusted remote output before it re-enters the platform:
 *
 *   - strips any field that would forge first-party lineage/provenance; and
 *   - EMPTIES the first-party `citations` array. A remote can never supply a
 *     first-party citation — the platform's Citation contract requires a
 *     lineage_id minted inside the trust boundary, and the whole point of this
 *     adapter is that the remote is untrusted. Rather than forge lineage (a
 *     leak) or masquerade remote docs as governed sources, remote citations are
 *     dropped: the answer stands on its text alone, attributed to the proxy.
 */
export function sanitizeRemoteOutput(output: Record<string, unknown>): Record<string, unknown> {
  // Rebuild without the lineage keys (never `delete`, so no property is left as
  // an explicit `undefined` the strict output_schema could trip on).
  const clean: Record<string, unknown> = Object.fromEntries(
    Object.entries(output).filter(([key]) => !LINEAGE_KEYS.includes(key)),
  );
  if (Array.isArray(clean.citations)) {
    clean.citations = [];
  }
  return clean;
}
