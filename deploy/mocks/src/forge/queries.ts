/** Pure query functions over the code-forge fixtures (no throwing). */

import type { QueryOutcome } from '../cloud/queries.js';
import type { DependencyEdge, ForgeFixtures } from './fixtures.js';

export interface RepoDependenciesArgs {
  repo: string;
  direction?: 'dependencies' | 'dependents' | undefined;
  transitive?: boolean | undefined;
}

interface PackageRef {
  repo: string;
  version: string;
  type: string;
  via?: string;
}

export function repoDependencies(fx: ForgeFixtures, args: RepoDependenciesArgs): QueryOutcome {
  if (!fx.catalog.repos.some((r) => r.repo === args.repo)) {
    return {
      kind: 'not_found',
      message: `repo ${args.repo} is not known to the forge — check the name`,
    };
  }
  const direction = args.direction ?? 'dependencies';
  const transitive = args.transitive ?? false;

  const neighbors = (repo: string): { edge: DependencyEdge; next: string }[] =>
    fx.dependencies.edges
      .filter((e) => (direction === 'dependencies' ? e.from === repo : e.to === repo))
      .map((e) => ({ edge: e, next: direction === 'dependencies' ? e.to : e.from }));

  // BFS with dedup by repo: the first (shortest) path wins; direct edges
  // carry no `via`, transitive ones name the repo that pulled them in.
  const packages: PackageRef[] = [];
  const seen = new Set<string>([args.repo]);
  let frontier: { repo: string; via?: string }[] = [{ repo: args.repo }];
  for (let depth = 0; frontier.length > 0 && (transitive || depth < 1); depth += 1) {
    const nextFrontier: { repo: string; via?: string }[] = [];
    for (const node of frontier) {
      for (const { edge, next } of neighbors(node.repo)) {
        if (seen.has(next)) continue;
        seen.add(next);
        const ref: PackageRef = { repo: next, version: edge.version, type: edge.type };
        if (depth > 0) ref.via = node.repo;
        packages.push(ref);
        nextFrontier.push({ repo: next });
      }
    }
    frontier = nextFrontier;
  }

  return {
    kind: 'ok',
    data: { repo: args.repo, direction, transitive, packages },
  };
}

export interface CiRunsArgs {
  repo: string;
  since?: string | undefined;
  until?: string | undefined;
}

export function ciRuns(fx: ForgeFixtures, args: CiRunsArgs): QueryOutcome {
  if (!fx.catalog.repos.some((r) => r.repo === args.repo)) {
    return {
      kind: 'not_found',
      message: `repo ${args.repo} is not known to the forge — check the name`,
    };
  }
  if (args.since !== undefined && args.until !== undefined && args.since > args.until) {
    return { kind: 'invalid_input', message: `since ${args.since} is after until ${args.until}` };
  }
  const runs = fx.ciRuns.runs
    .filter(
      (r) =>
        r.repo === args.repo &&
        (args.since === undefined || r.finished_at.slice(0, 10) >= args.since) &&
        (args.until === undefined || r.finished_at.slice(0, 10) <= args.until),
    )
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1));
  return {
    kind: 'ok',
    data: { repo: args.repo, as_of: fx.ciRuns.as_of, runs },
  };
}
