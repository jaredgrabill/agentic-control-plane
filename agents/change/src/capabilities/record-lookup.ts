/**
 * change.record_lookup (R0) — deterministic, extractive: one
 * change_record_lookup call finds the change record(s) linked to a service
 * and/or a deploy id, templated from the tool data and cited against the
 * change log. This is the read that closes a cost-spike forensics chain — the
 * deploy that drove a spend change is linked back to its change record. A
 * covered-but-empty result reports "no linked change", still cited; it is not
 * an abstention (the change log genuinely holds no such link).
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, ITSM, primaryProvenance } from '../tools.js';

interface RecordLookupInput {
  service?: string;
  deploy_id?: string;
}

interface ChangeRow {
  change_id: string;
  title: string;
  service?: string;
  deploy_id?: string;
  status: string;
}

export function registerRecordLookup(agent: Agent, tools: ToolClient): void {
  agent.capability('change.record_lookup', async (ctx, rawInput) => {
    const input = rawInput as RecordLookupInput;
    if (
      (typeof input.service !== 'string' || input.service.length === 0) &&
      (typeof input.deploy_id !== 'string' || input.deploy_id.length === 0)
    ) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide at least one of service or deploy_id to look up a change record',
      );
    }

    const response = await tools.call(
      ITSM,
      'change_record_lookup',
      {
        ...(input.service === undefined ? {} : { service: input.service }),
        ...(input.deploy_id === undefined ? {} : { deploy_id: input.deploy_id }),
      },
      callOptions(ctx),
    );
    const data = response.data as { changes: ChangeRow[]; total_matched: number };

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    const filterParts: string[] = [];
    if (input.deploy_id !== undefined) filterParts.push(`deploy ${input.deploy_id}`);
    if (input.service !== undefined) filterParts.push(`service ${input.service}`);
    const filterDesc = filterParts.join(' / ');

    if (data.changes.length === 0) {
      builder.paragraph(`No change record links to ${filterDesc} in the change log. [${marker}]`);
      return { ...builder.build(0.9), changes: [], total_matched: 0 };
    }

    const lines = data.changes
      .map((c) => {
        const on = c.service === undefined ? '' : ` on ${c.service}`;
        const deploy = c.deploy_id === undefined ? '' : `, deploy ${c.deploy_id}`;
        return `- ${c.change_id} (${c.status}): "${c.title}"${on}${deploy}`;
      })
      .join('\n');
    const plural = data.changes.length === 1 ? '' : 's';
    builder.paragraph(
      `${String(data.changes.length)} change record${plural} ` +
        `link${data.changes.length === 1 ? 's' : ''} to ${filterDesc}: [${marker}]`,
    );
    builder.paragraph(lines);
    return {
      ...builder.build(0.9),
      changes: data.changes,
      total_matched: data.total_matched,
    };
  });
}
