/**
 * change.withdraw (R2) — withdraws a submitted change. It is BOTH a directly
 * invokable capability (gated on approval) AND the declared compensator of
 * change.submit: on a saga unwind the orchestrator dispatches it with the
 * original write's recorded output ({original: {step_id, capability, input,
 * output}}, the compensator convention), from which it recovers the change_id.
 * The idempotency key is the step id.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, idempotencyKey, ITSM, primaryProvenance } from '../tools.js';

interface Original {
  input?: { change_id?: string };
  output?: { change_id?: string };
}

interface WithdrawInput {
  change_id?: string;
  reason?: string;
  original?: Original;
}

/** Recover the change_id from a direct arg or the compensator's `original` handle. */
function resolveChangeId(input: WithdrawInput): string | undefined {
  if (typeof input.change_id === 'string' && input.change_id.startsWith('CHG-')) {
    return input.change_id;
  }
  const fromOutput = input.original?.output?.change_id;
  if (typeof fromOutput === 'string' && fromOutput.startsWith('CHG-')) return fromOutput;
  const fromInput = input.original?.input?.change_id;
  if (typeof fromInput === 'string' && fromInput.startsWith('CHG-')) return fromInput;
  return undefined;
}

export function registerWithdraw(agent: Agent, tools: ToolClient): void {
  agent.capability('change.withdraw', async (ctx, rawInput) => {
    const input = rawInput as WithdrawInput;
    const changeId = resolveChangeId(input);
    if (changeId === undefined) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide a change_id (or an original write handle carrying one) to withdraw',
      );
    }

    const response = await tools.call(
      ITSM,
      'change_withdraw',
      {
        change_id: changeId,
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
        idempotency_key: idempotencyKey(ctx),
      },
      callOptions(ctx),
    );
    const data = response.data as { change_id: string; status: string; previous_status: string };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    builder.paragraph(
      `Withdrew change ${data.change_id} (was ${data.previous_status}, now ${data.status}). ` +
        `[${marker}]`,
    );
    return {
      ...builder.build(0.9),
      change_id: data.change_id,
      status: data.status,
      previous_status: data.previous_status,
    };
  });
}
