/**
 * cloud.tag_apply (R2) — sets tags on an inventory resource. A production
 * write: gated on human approval, reversible by its compensator
 * cloud.tag_restore. The tool returns the PREVIOUS value of every key it set
 * (null when the key was absent); the handler surfaces `previous` in the output
 * so the compensator can restore the honest prior state, not blindly delete.
 * The idempotency key is the step id (a retried apply never double-applies).
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, CLOUD_ESTATE, idempotencyKey, primaryProvenance } from '../tools.js';

interface TagApplyInput {
  resource_id?: string;
  tags?: Record<string, string>;
}

export function registerTagApply(agent: Agent, tools: ToolClient): void {
  agent.capability('cloud.tag_apply', async (ctx, rawInput) => {
    const input = rawInput as TagApplyInput;
    if (typeof input.resource_id !== 'string' || input.resource_id === '') {
      throw new CapabilityError(ErrorClass.NeedsInput, 'resource_id is required');
    }
    const tags = input.tags;
    if (
      tags === undefined ||
      typeof tags !== 'object' ||
      Object.keys(tags).length < 1 ||
      !Object.values(tags).every((v) => typeof v === 'string')
    ) {
      throw new CapabilityError(ErrorClass.NeedsInput, 'tags must map 1..10 keys to string values');
    }

    const response = await tools.call(
      CLOUD_ESTATE,
      'tag_apply',
      { resource_id: input.resource_id, tags, idempotency_key: idempotencyKey(ctx) },
      callOptions(ctx),
    );
    const data = response.data as {
      resource_id: string;
      applied: Record<string, string>;
      previous: Record<string, string | null>;
    };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    const keys = Object.keys(data.applied).join(', ');
    builder.paragraph(
      `Applied tags [${keys}] to ${data.resource_id}. Previous values recorded for reversal. ` +
        `[${marker}]`,
    );
    return {
      ...builder.build(0.9),
      resource_id: data.resource_id,
      applied: data.applied,
      previous: data.previous,
    };
  });
}
