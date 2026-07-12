/**
 * cloud-estate fixture loading: the acme-corp cloud snapshot + cost report.
 * Every dataset carries a Citation-compatible `document` header with a fixed
 * lineage_id — document-granularity provenance for tool answers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provenance } from '@acp/tool-client';

export interface CloudResource {
  resource_id: string;
  type: string;
  service: string;
  env: string;
  region: string;
  size: string;
  monthly_cost_usd: number;
  created_at: string;
  tags: Record<string, string>;
}

export interface InventoryFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  resources: CloudResource[];
}

export interface CostWeek {
  week_start: string;
  by_service: Record<string, number>;
  total: number;
}

export interface CostsFixture {
  document: Provenance;
  currency: string;
  complete_through: string;
  weeks: CostWeek[];
}

export interface CloudFixtures {
  inventory: InventoryFixture;
  costs: CostsFixture;
}

/** Repo-root fixtures/acme-corp, resolved from this module (dist/cloud/…). */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../fixtures/acme-corp', import.meta.url),
);

export function fixturesDir(): string {
  return process.env.ACP_MOCK_FIXTURES ?? DEFAULT_FIXTURES_DIR;
}

export function loadCloudFixtures(dir: string = fixturesDir()): CloudFixtures {
  return {
    inventory: readJson(join(dir, 'cloud', 'inventory.json')) as unknown as InventoryFixture,
    costs: readJson(join(dir, 'cloud', 'costs.json')) as unknown as CostsFixture,
  };
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/** The document header as the provenance list every answer from it carries. */
export function provenanceOf(document: Provenance): Provenance[] {
  return [document];
}
