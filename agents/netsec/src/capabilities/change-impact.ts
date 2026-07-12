/**
 * netsec.change_impact (R0) — pure analysis of a PROPOSED rule change: one
 * firewall_rules_search over the overlap (same direction and port), then a
 * templated risk read-out. Nothing is mutated — the proposal is data, and the
 * only tool call is a read.
 *
 * Widening logic (deterministic): adding an ingress rule sourced from the
 * open internet widens exposure; removing a rule widens exposure when the
 * overlapping existing rules it would strike include a deny (removing a
 * guard re-opens what it blocked).
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, NETSEC, primaryProvenance } from '../tools.js';
import type { RuleRecord } from './rule-search.js';

const INTERNET = '0.0.0.0/0';

interface Proposed {
  action?: string;
  direction?: string;
  port?: number;
  source_cidr?: string;
  service?: string;
}

interface ChangeImpactInput {
  proposed?: Proposed;
}

export function registerChangeImpact(agent: Agent, tools: ToolClient): void {
  agent.capability('netsec.change_impact', async (ctx, rawInput) => {
    const input = rawInput as ChangeImpactInput;
    const proposed = input.proposed;
    if (
      proposed === undefined ||
      (proposed.action !== 'add' && proposed.action !== 'remove') ||
      (proposed.direction !== 'ingress' && proposed.direction !== 'egress') ||
      !Number.isInteger(proposed.port) ||
      typeof proposed.source_cidr !== 'string' ||
      proposed.source_cidr.length === 0
    ) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'provide a proposed rule change with action (add|remove), direction ' +
          '(ingress|egress), port, and source_cidr',
      );
    }

    const response = await tools.call(
      NETSEC,
      'firewall_rules_search',
      {
        direction: proposed.direction,
        port: proposed.port,
        ...(proposed.service === undefined ? {} : { service: proposed.service }),
      },
      callOptions(ctx),
    );
    const data = response.data as { rules: RuleRecord[] };
    const overlapping = data.rules;

    const widensExposure =
      proposed.action === 'add'
        ? proposed.direction === 'ingress' && proposed.source_cidr === INTERNET
        : overlapping.some((r) => r.action === 'deny');
    const affectedServices =
      proposed.service === undefined
        ? [...new Set(overlapping.map((r) => r.service))]
        : [proposed.service];

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    const change =
      `${proposed.action} ${proposed.direction} port ${String(proposed.port)} ` +
      `from ${proposed.source_cidr}` +
      (proposed.service === undefined ? '' : ` on ${proposed.service}`);

    builder.paragraph(
      `The proposed change (${change}) ${
        widensExposure
          ? 'WIDENS internet exposure' +
            (proposed.action === 'add'
              ? `: it admits the open internet (${INTERNET}) on a new ingress path`
              : ': it removes a deny rule, re-opening traffic that rule blocked')
          : 'does not widen internet exposure'
      }. Affected service${affectedServices.length === 1 ? '' : 's'}: ${
        affectedServices.length === 0 ? 'none identified' : affectedServices.join(', ')
      }. [${marker}]`,
    );
    if (overlapping.length > 0) {
      builder.paragraph(
        `${String(overlapping.length)} existing rule${overlapping.length === 1 ? '' : 's'} ` +
          `overlap the same direction and port: [${marker}]`,
      );
      builder.paragraph(
        overlapping
          .map((r) => `- ${r.rule_id} ${r.action} ${r.service} from ${r.source_cidr}`)
          .join('\n'),
      );
    }
    return {
      ...builder.build(0.9),
      widens_exposure: widensExposure,
      affected_services: affectedServices,
      overlapping_rules: overlapping,
    };
  });
}
