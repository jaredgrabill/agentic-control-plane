/**
 * netsec.rule_search (R0) — deterministic, extractive: one
 * firewall_rules_search call, answer templated from the tool data, cited
 * against the firewall ruleset snapshot. Abstains when a service filter falls
 * outside the ruleset's coverage (the ruleset genuinely cannot answer), which
 * is a real abstention signal, not a confident "no rules".
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, NETSEC, primaryProvenance } from '../tools.js';

interface RuleSearchInput {
  service?: string;
  cidr?: string;
  port?: number;
  direction?: string;
  limit?: number;
}

export interface RuleRecord {
  rule_id: string;
  service: string;
  direction: string;
  port: number;
  source_cidr: string;
  action: string;
}

export function registerRuleSearch(agent: Agent, tools: ToolClient): void {
  agent.capability('netsec.rule_search', async (ctx, rawInput) => {
    const input = rawInput as RuleSearchInput;
    if (
      input.service === undefined &&
      input.cidr === undefined &&
      input.port === undefined &&
      input.direction === undefined
    ) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide at least one filter (service, cidr, port, or direction) — an unbounded ' +
          'ruleset dump is not a question',
      );
    }

    const response = await tools.call(
      NETSEC,
      'firewall_rules_search',
      {
        ...(input.service === undefined ? {} : { service: input.service }),
        ...(input.cidr === undefined ? {} : { cidr: input.cidr }),
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      callOptions(ctx),
    );
    const data = response.data as {
      rules: RuleRecord[];
      total_matched: number;
      truncated: boolean;
      service_covered?: boolean;
    };

    const builder = agent.answerBuilder();
    // A service the ruleset does not cover cannot be searched — abstain
    // rather than report a misleading "no rules for this service".
    if (data.service_covered === false) {
      return {
        ...builder.abstain(
          `The firewall ruleset snapshot has no coverage for service ` +
            `${input.service ?? ''} — it cannot answer rule questions about it.`,
        ),
      };
    }

    const marker = builder.cite(primaryProvenance(response));
    const filters = [
      ...(input.service === undefined ? [] : [`service ${input.service}`]),
      ...(input.direction === undefined ? [] : [input.direction]),
      ...(input.port === undefined ? [] : [`port ${String(input.port)}`]),
      ...(input.cidr === undefined ? [] : [`source ${input.cidr}`]),
    ].join(', ');

    if (data.rules.length === 0) {
      builder.paragraph(`No firewall rules match ${filters}. [${marker}]`);
      return { ...builder.build(0.9), rules: [], total_matched: 0, truncated: false };
    }

    const lines = data.rules
      .map(
        (r) =>
          `- ${r.rule_id} ${r.action} ${r.direction} ${r.service} port ${String(r.port)} ` +
          `from ${r.source_cidr}`,
      )
      .join('\n');
    const truncatedNote = data.truncated
      ? ` (showing ${String(data.rules.length)} of ${String(data.total_matched)})`
      : '';
    builder.paragraph(
      `${String(data.total_matched)} firewall rule${data.total_matched === 1 ? '' : 's'} ` +
        `match ${filters}${truncatedNote}: [${marker}]`,
    );
    builder.paragraph(lines);
    return {
      ...builder.build(0.9),
      rules: data.rules,
      total_matched: data.total_matched,
      truncated: data.truncated,
    };
  });
}
