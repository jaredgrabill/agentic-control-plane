/**
 * change.conflict_check (R0) — deterministic, extractive: one
 * calendar_conflicts call, answer templated from the tool data, cited against
 * the change calendar. Abstains when the window ends beyond the calendar's
 * coverage horizon (the calendar genuinely cannot answer), which is a real
 * abstention signal, not a confident "no conflicts".
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, ITSM, primaryProvenance } from '../tools.js';

interface Window {
  start?: string;
  end?: string;
}

interface ConflictInput {
  window?: Window;
  service?: string;
}

interface ScheduledConflict {
  change_id: string;
  title: string;
  service?: string;
}

interface Freeze {
  name: string;
  reason?: string;
}

export function registerConflictCheck(agent: Agent, tools: ToolClient): void {
  agent.capability('change.conflict_check', async (ctx, rawInput) => {
    const input = rawInput as ConflictInput;
    const window = input.window;
    if (
      window === undefined ||
      typeof window.start !== 'string' ||
      typeof window.end !== 'string'
    ) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide a maintenance window with start and end (ISO 8601 instants)',
      );
    }

    const response = await tools.call(
      ITSM,
      'calendar_conflicts',
      {
        window: { start: window.start, end: window.end },
        ...(input.service === undefined ? {} : { service: input.service }),
      },
      callOptions(ctx),
    );
    const data = response.data as {
      coverage_through: string;
      within_coverage: boolean;
      conflicts: ScheduledConflict[];
      freezes: Freeze[];
    };

    const builder = agent.answerBuilder();
    // Beyond the coverage horizon the calendar cannot answer — abstain rather
    // than report a misleading "no conflicts".
    if (!data.within_coverage) {
      return {
        ...builder.abstain(
          `The proposed window ends after the change calendar's coverage horizon ` +
            `(${data.coverage_through}); it cannot be checked for conflicts yet.`,
        ),
      };
    }

    const marker = builder.cite(primaryProvenance(response));
    const scope = input.service === undefined ? '' : ` for ${input.service}`;

    if (data.conflicts.length === 0 && data.freezes.length === 0) {
      builder.paragraph(
        `The window ${window.start} to ${window.end}${scope} is clear: no scheduled ` +
          `changes or change freezes overlap it. [${marker}]`,
      );
      return { ...builder.build(0.9) };
    }

    if (data.freezes.length > 0) {
      const names = data.freezes.map((f) => f.name).join(', ');
      builder.paragraph(
        `The window ${window.start} to ${window.end}${scope} falls inside a change freeze ` +
          `(${names}) — do not schedule production changes here. [${marker}]`,
      );
    }
    if (data.conflicts.length > 0) {
      const lines = data.conflicts.map((c) => `- ${c.change_id} ${c.title}`).join('\n');
      builder.paragraph(
        `${data.conflicts.length} scheduled change${data.conflicts.length === 1 ? '' : 's'} ` +
          `overlap the window${scope}: [${marker}]`,
      );
      builder.paragraph(lines);
    }
    return { ...builder.build(0.9) };
  });
}
