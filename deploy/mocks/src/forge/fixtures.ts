/**
 * code-forge fixture loading: the acme-corp repo catalog, dependency graph,
 * and CI activity, each with a Citation-compatible `document` header.
 */

import { join } from 'node:path';
import type { Provenance } from '@acp/tool-client';
import { fixturesDir, readJson } from '../cloud/fixtures.js';

export interface RepoEntry {
  repo: string;
  team: string;
  oncall?: string;
  default_branch?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  version: string;
  type: string;
}

export interface CiRun {
  run_id: string;
  repo: string;
  status: 'success' | 'failed';
  branch: string;
  commit: string;
  message: string;
  actor: string;
  finished_at: string;
  environment?: string;
  deploy_id?: string;
}

export interface ForgeFixtures {
  catalog: { document: Provenance; as_of: string; repos: RepoEntry[] };
  dependencies: { document: Provenance; as_of: string; edges: DependencyEdge[] };
  ciRuns: { document: Provenance; as_of: string; runs: CiRun[] };
}

export function loadForgeFixtures(dir: string = fixturesDir()): ForgeFixtures {
  return {
    catalog: readJson(join(dir, 'code', 'repos.json')) as unknown as ForgeFixtures['catalog'],
    dependencies: readJson(
      join(dir, 'code', 'dependencies.json'),
    ) as unknown as ForgeFixtures['dependencies'],
    ciRuns: readJson(join(dir, 'code', 'ci-runs.json')) as unknown as ForgeFixtures['ciRuns'],
  };
}
