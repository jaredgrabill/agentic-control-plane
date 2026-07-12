/**
 * netsec.exposure_analysis (R0) — deterministic, extractive: security groups
 * cross-referenced with IPAM allocations. An exposure is an ingress rule that
 * admits 0.0.0.0/0; internet_exposed additionally requires a public IPAM
 * allocation for the service. Abstains when the named service is absent from
 * BOTH snapshots — "no data" must never read as a confident "no exposure".
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { callOptions, NETSEC, primaryProvenance } from '../tools.js';

const INTERNET = '0.0.0.0/0';

interface ExposureInput {
  service?: string;
  include_ports?: number[];
}

interface Group {
  security_group_id: string;
  service: string;
  ingress: { port: number; source_cidr: string }[];
}

interface Allocation {
  service: string;
  zone: string;
}

interface Exposure {
  security_group_id: string;
  port: number;
  source_cidr: string;
  service: string;
}

export function registerExposureAnalysis(agent: Agent, tools: ToolClient): void {
  agent.capability('netsec.exposure_analysis', async (ctx, rawInput) => {
    const input = rawInput as ExposureInput;
    if (
      input.include_ports !== undefined &&
      (!Array.isArray(input.include_ports) || input.include_ports.some((p) => !Number.isInteger(p)))
    ) {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'include_ports must be an array of integer ports',
      );
    }

    const serviceArgs = input.service === undefined ? {} : { service: input.service };
    const sgResponse = await tools.call(
      NETSEC,
      'security_group_get',
      serviceArgs,
      callOptions(ctx),
    );
    const ipamResponse = await tools.call(NETSEC, 'ipam_lookup', serviceArgs, callOptions(ctx));
    const groups = (sgResponse.data as { groups: Group[] }).groups;
    const allocations = (ipamResponse.data as { allocations: Allocation[] }).allocations;

    const builder = agent.answerBuilder();
    // A service in neither snapshot is outside netsec coverage entirely —
    // abstain rather than certify a service we cannot see as unexposed.
    if (input.service !== undefined && groups.length === 0 && allocations.length === 0) {
      return {
        ...builder.abstain(
          `Service ${input.service} is absent from both the security-group and IPAM ` +
            `snapshots — its exposure cannot be assessed from the netsec data.`,
        ),
      };
    }

    const wantedPorts = input.include_ports;
    const exposures: Exposure[] = groups.flatMap((group) =>
      group.ingress
        .filter(
          (rule) =>
            rule.source_cidr === INTERNET &&
            (wantedPorts === undefined || wantedPorts.includes(rule.port)),
        )
        .map((rule) => ({
          security_group_id: group.security_group_id,
          port: rule.port,
          source_cidr: rule.source_cidr,
          service: group.service,
        })),
    );
    const publicServices = new Set(
      allocations.filter((a) => a.zone === 'public').map((a) => a.service),
    );
    const internetExposed = exposures.some((e) => publicServices.has(e.service));

    const sgMarker = builder.cite(primaryProvenance(sgResponse));
    const ipamMarker = builder.cite(primaryProvenance(ipamResponse));
    const scope = input.service ?? 'the acme estate';

    if (exposures.length === 0) {
      builder.paragraph(
        `No security group for ${scope} admits ${INTERNET} on any` +
          `${wantedPorts === undefined ? '' : ' requested'} port — no internet exposure in ` +
          `the security-group snapshot. [${sgMarker}][${ipamMarker}]`,
      );
      return { ...builder.build(0.9), exposures: [], internet_exposed: false };
    }

    const lines = exposures
      .map(
        (e) =>
          `- ${e.security_group_id} (${e.service}) admits ${e.source_cidr} on port ` +
          String(e.port),
      )
      .join('\n');
    builder.paragraph(
      `${scope === 'the acme estate' ? 'The acme estate has' : `${scope} has`} ` +
        `${String(exposures.length)} internet-facing ingress rule` +
        `${exposures.length === 1 ? '' : 's'} (${INTERNET}) — ` +
        `${
          internetExposed
            ? 'and public IPAM allocations make this reachable from the internet'
            : 'but no public IPAM allocation was found, so reachability is limited to the ' +
              'security-group layer'
        }. [${sgMarker}][${ipamMarker}]`,
    );
    builder.paragraph(lines);
    return { ...builder.build(0.9), exposures, internet_exposed: internetExposed };
  });
}
