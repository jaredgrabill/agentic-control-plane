/**
 * change.submit (R2) — submits a draft change for approval. A production write:
 * the platform gates it on human approval before the tool call reaches the
 * gateway, and its compensator change.withdraw reverses it on a saga unwind.
 * The idempotency key is the step id (a retried submit never double-submits).
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, idempotencyKey, ITSM, primaryProvenance } from '../tools.js';

interface SubmitInput {
  change_id?: string;
}

export function registerSubmit(agent: Agent, tools: ToolClient): void {
  agent.capability('change.submit', async (ctx, rawInput) => {
    const input = rawInput as SubmitInput;
    if (typeof input.change_id !== 'string' || !input.change_id.startsWith('CHG-')) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'change_id is required and must be a CHG- identifier',
      );
    }

    const response = await tools.call(
      ITSM,
      'change_submit',
      { change_id: input.change_id, idempotency_key: idempotencyKey(ctx) },
      callOptions(ctx),
    );
    const data = response.data as { change_id: string; status: string; previous_status: string };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    builder.paragraph(
      `Submitted change ${data.change_id} for approval (was ${data.previous_status}, now ` +
        `${data.status}). [${marker}]`,
    );
    return {
      ...builder.build(0.9),
      change_id: data.change_id,
      status: data.status,
      previous_status: data.previous_status,
    };
  });
}
