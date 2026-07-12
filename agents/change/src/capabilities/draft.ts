/**
 * change.draft (R1) — creates a draft change via change_create_draft. The
 * idempotency key is the step id (retries never create a duplicate draft). The
 * output carries the assigned change_id and status for downstream steps.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, idempotencyKey, ITSM, primaryProvenance } from '../tools.js';

interface Window {
  start: string;
  end: string;
}

interface DraftInput {
  title?: string;
  description?: string;
  service?: string;
  window?: Window;
}

export function registerDraft(agent: Agent, tools: ToolClient): void {
  agent.capability('change.draft', async (ctx, rawInput) => {
    const input = rawInput as DraftInput;
    if (typeof input.title !== 'string' || input.title.length < 8 || input.title.length > 200) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'title is required and must be 8..200 characters',
      );
    }

    const response = await tools.call(
      ITSM,
      'change_create_draft',
      {
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.service === undefined ? {} : { service: input.service }),
        ...(input.window === undefined ? {} : { window: input.window }),
        idempotency_key: idempotencyKey(ctx),
      },
      callOptions(ctx),
    );
    const data = response.data as { change_id: string; status: string };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    const forService = input.service === undefined ? '' : ` for ${input.service}`;
    builder.paragraph(
      `Created draft change ${data.change_id}${forService}: "${input.title}" (status ${data.status}). ` +
        `Submit it for approval to schedule it. [${marker}]`,
    );
    return { ...builder.build(0.9), change_id: data.change_id, status: data.status };
  });
}
