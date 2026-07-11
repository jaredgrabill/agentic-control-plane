/**
 * code.dependency_query — deterministic, extractive, zero-LLM: one
 * repo_dependencies call, answer templated from the edge list, cited
 * against the dependency-graph document.
 */

import { CapabilityError, ErrorClass, type Agent } from '@acp/agent-sdk';
import type { ToolClient } from '@acp/tool-client';
import { CODE_FORGE, primaryProvenance, REPO_PATTERN } from '../tools.js';

interface DependencyInput {
  repo?: string | undefined;
  direction?: string | undefined;
  transitive?: boolean | undefined;
}

interface PackageRef {
  repo: string;
  version: string;
  type: string;
  via?: string;
}

export function requireRepo(input: { repo?: unknown }): string {
  if (typeof input.repo !== 'string' || !REPO_PATTERN.test(input.repo)) {
    throw new CapabilityError(
      ErrorClass.NeedsInput,
      'repo must look like org/name (e.g. acme/payments-service)',
    );
  }
  return input.repo;
}

/** `acme/platform-sdk@2.4.1 (library)` — with `via` for transitive edges. */
export function formatPackage(pkg: PackageRef): string {
  const via = pkg.via === undefined ? '' : `, via ${pkg.via}`;
  return `${pkg.repo}@${pkg.version} (${pkg.type}${via})`;
}

export function registerDependencyQuery(agent: Agent, tools: ToolClient): void {
  agent.capability('code.dependency_query', async (_ctx, rawInput) => {
    const input = rawInput as DependencyInput;
    const repo = requireRepo(input);
    const direction = input.direction ?? 'dependencies';
    if (direction !== 'dependencies' && direction !== 'dependents') {
      throw new CapabilityError(
        ErrorClass.NeedsInput,
        'direction must be dependencies or dependents',
      );
    }
    const transitive = input.transitive ?? false;

    const response = await tools.call(CODE_FORGE, 'repo_dependencies', {
      repo,
      direction,
      transitive,
    });
    const packages = (response.data.packages ?? []) as PackageRef[];

    const builder = agent.answerBuilder();
    const marker = builder.cite(primaryProvenance(response));
    if (direction === 'dependents') {
      if (packages.length === 0) {
        builder.paragraph(`No repos depend on ${repo}. [${marker}]`);
      } else {
        const verb = packages.length === 1 ? 'repo depends' : 'repos depend';
        builder.paragraph(
          `${packages.length} ${verb} on ${repo}: ` +
            `${packages.map((p) => p.repo).join(', ')}. [${marker}]`,
        );
      }
    } else if (packages.length === 0) {
      builder.paragraph(`${repo} has no recorded dependencies. [${marker}]`);
    } else {
      const scope = transitive ? 'dependencies (direct and transitive)' : 'direct dependencies';
      const noun = packages.length === 1 ? scope.replace('dependencies', 'dependency') : scope;
      builder.paragraph(
        `${repo} has ${packages.length} ${noun}: ` +
          `${packages.map(formatPackage).join(', ')}. [${marker}]`,
      );
    }
    return { ...builder.build(response.partial === true ? 0.55 : 0.9) };
  });
}
