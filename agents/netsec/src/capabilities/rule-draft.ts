/**
 * netsec.rule_draft (R1) — SIDE-EFFECT-FREE: produces a human-reviewable
 * proposed rule change (structured rule + rationale), grounded via ONE
 * firewall_rules_search read and cited against the ruleset snapshot. It calls
 * only read tools, passes no idempotency key, and writes nothing — there is
 * no netsec store in v0 and no external firewall is touched. R1 because the
 * output is a proposed-change artifact (the R1 draft contract), not because
 * anything mutates.
 *
 * Injection posture: `intent` is operator prose and rides as LITERAL data —
 * it is quoted verbatim into the rationale and never parsed into the rule.
 * The drafted rule is assembled ONLY from the structured fields; an
 * unspecified source_cidr defaults to the internal corporate range
 * (10.0.0.0/8), never the open internet. Enactment-shaped input (an `apply`
 * field, or any field outside the declared schema) is refused typed: this
 * agent has no apply path, and pretending to accept one would train callers
 * to expect it.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, NETSEC, primaryProvenance } from '../tools.js';
import type { RuleRecord } from './rule-search.js';

/** Secure default for an unspecified source: internal corporate, never 0.0.0.0/0. */
const INTERNAL_DEFAULT_CIDR = '10.0.0.0/8';

const KNOWN_KEYS = new Set(['service', 'intent', 'direction', 'port', 'source_cidr']);

interface RuleDraftInput {
  service?: string;
  intent?: string;
  direction?: string;
  port?: number;
  source_cidr?: string;
}

export function registerRuleDraft(agent: Agent, tools: ToolClient): void {
  agent.capability('netsec.rule_draft', async (ctx, rawInput) => {
    // additionalProperties:false is the declared contract; enforce it here so
    // an enactment-shaped field ("apply": true) is a typed refusal, not a
    // silently ignored hint. rule_draft drafts — nothing on this agent applies.
    const unknownKeys = Object.keys(rawInput).filter((k) => !KNOWN_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        `unsupported field${unknownKeys.length === 1 ? '' : 's'} ${unknownKeys.join(', ')} — ` +
          'netsec.rule_draft produces a reviewable draft only; applying a rule is not a ' +
          'capability of this agent',
      );
    }

    const input = rawInput as RuleDraftInput;
    if (typeof input.service !== 'string' || input.service.length === 0) {
      throw new CapabilityError(ErrorClass.NeedsInput, 'service is required');
    }
    if (typeof input.intent !== 'string' || input.intent.length < 8 || input.intent.length > 500) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'intent is required and must be 8..500 characters of reviewer-facing rationale',
      );
    }
    if (
      input.direction !== undefined &&
      input.direction !== 'ingress' &&
      input.direction !== 'egress'
    ) {
      throw new CapabilityError(ErrorClass.NeedsInput, 'direction must be ingress or egress');
    }

    // Grounding read: the current rules for the service. The ONLY tool call —
    // a read, with no idempotency key (nothing here is a write).
    const response = await tools.call(
      NETSEC,
      'firewall_rules_search',
      { service: input.service },
      callOptions(ctx),
    );
    const data = response.data as { rules: RuleRecord[]; service_covered?: boolean };

    const builder = agent.answerBuilder();
    // A draft for a service the ruleset does not cover cannot be grounded —
    // abstain rather than invent a rule out of thin air.
    if (data.service_covered === false) {
      return {
        ...builder.abstain(
          `The firewall ruleset snapshot has no coverage for service ${input.service} — a ` +
            `draft cannot be grounded in its current rules.`,
        ),
      };
    }

    const direction = input.direction ?? 'ingress';
    const port = input.port ?? data.rules.find((r) => r.direction === direction)?.port;
    if (port === undefined || !Number.isInteger(port)) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        `no port was given and ${input.service} has no existing ${direction} rule to ` +
          'ground a default on — provide a port',
      );
    }
    const sourceCidr = input.source_cidr ?? INTERNAL_DEFAULT_CIDR;

    const draftRule = {
      service: input.service,
      direction,
      port,
      source_cidr: sourceCidr,
      action: 'allow' as const,
    };
    const replaced = data.rules.filter(
      (r) => r.direction === direction && r.port === port && r.action === 'allow',
    );
    const rationale =
      `Operator intent (verbatim): "${input.intent}". Drafted from the structured request ` +
      `fields against the current ${input.service} rules` +
      (replaced.length > 0
        ? `; on review, this proposal supersedes ${replaced
            .map((r) => `${r.rule_id} (from ${r.source_cidr})`)
            .join(', ')} for the same direction and port`
        : '; no existing allow rule shares this direction and port') +
      '.';

    const marker = builder.cite(primaryProvenance(response));
    builder.paragraph(
      `Draft (proposed, NOT applied): allow ${direction} port ${String(port)} from ` +
        `${sourceCidr} on ${input.service}. This is a reviewable proposal only — applying ` +
        `it is outside this agent's capabilities. [${marker}]`,
    );
    builder.paragraph(rationale);
    return { ...builder.build(0.9), draft_rule: draftRule, rationale };
  });
}
