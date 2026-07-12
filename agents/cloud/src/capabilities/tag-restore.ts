/**
 * cloud.tag_restore (R2) — the honest inverse of cloud.tag_apply and its
 * declared compensator (mutual pair). It restores the PRIOR tag state from the
 * `previous` map cloud.tag_apply recorded: keys that had a prior value are
 * re-applied (tag_apply); keys that were absent are removed (tag_remove).
 * Removing alone would lie when the apply overwrote an existing value — so this
 * restores previous values, not just deletes.
 *
 * It accepts the compensator convention {original: {output: {resource_id,
 * previous}}} (a saga unwind) or a direct {resource_id, previous}. The two
 * writes suffix the step-id idempotency key deterministically so each is
 * de-duplicated independently (design §D5).
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, CLOUD_ESTATE, idempotencyKey, primaryProvenance } from '../tools.js';

type PreviousMap = Record<string, string | null>;

interface RestoreState {
  resource_id: string;
  previous: PreviousMap;
}

interface RestoreInput {
  resource_id?: string;
  previous?: PreviousMap;
  original?: { output?: { resource_id?: string; previous?: PreviousMap } };
}

/** Recover the resource + previous map from a direct arg or the original handle. */
function resolveState(input: RestoreInput): RestoreState | undefined {
  const resourceId = input.resource_id ?? input.original?.output?.resource_id;
  const previous = input.previous ?? input.original?.output?.previous;
  if (typeof resourceId !== 'string' || resourceId === '' || previous === undefined) {
    return undefined;
  }
  return { resource_id: resourceId, previous };
}

export function registerTagRestore(agent: Agent, tools: ToolClient): void {
  agent.capability('cloud.tag_restore', async (ctx, rawInput) => {
    const state = resolveState(rawInput);
    if (state === undefined) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide resource_id and the previous tag map (or the original write handle carrying them)',
      );
    }

    const toReapply: Record<string, string> = {};
    const toRemove: string[] = [];
    for (const [key, value] of Object.entries(state.previous)) {
      if (value === null) toRemove.push(key);
      else toReapply[key] = value;
    }

    const builder = agent.answerBuilder();
    let cited: number | undefined;
    // Re-apply keys that had a prior value.
    if (Object.keys(toReapply).length > 0) {
      const applied = await tools.call(
        CLOUD_ESTATE,
        'tag_apply',
        {
          resource_id: state.resource_id,
          tags: toReapply,
          idempotency_key: idempotencyKey(ctx, ':restore:apply'),
        },
        callOptions(ctx),
      );
      cited = builder.cite(primaryProvenance(applied));
    }
    // Remove keys that were absent before the apply.
    if (toRemove.length > 0) {
      const removed = await tools.call(
        CLOUD_ESTATE,
        'tag_remove',
        {
          resource_id: state.resource_id,
          keys: toRemove,
          idempotency_key: idempotencyKey(ctx, ':restore:remove'),
        },
        callOptions(ctx),
      );
      cited = builder.cite(primaryProvenance(removed));
    }
    if (cited === undefined) {
      // Nothing to restore (empty previous map) — a well-formed no-op, no tool
      // call and nothing to cite.
      builder.paragraph(`No prior tag state to restore on ${state.resource_id}.`);
      return { ...builder.build(0.9), resource_id: state.resource_id };
    }

    builder.paragraph(
      `Restored prior tag state on ${state.resource_id}: re-applied ` +
        `[${Object.keys(toReapply).join(', ')}], removed [${toRemove.join(', ')}]. [${cited}]`,
    );
    return { ...builder.build(0.9), resource_id: state.resource_id };
  });
}
