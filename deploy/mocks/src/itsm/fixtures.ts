/**
 * itsm fixture loading: the acme-corp change log + change calendar, each with
 * a Citation-compatible `document` header carrying a fixed lineage_id —
 * document-granularity provenance for change answers.
 */

import { join } from 'node:path';
import type { Provenance } from '@acp/tool-client';
import { fixturesDir, readJson } from '../cloud/fixtures.js';

export type ChangeStatus = 'draft' | 'submitted' | 'withdrawn' | 'closed';

export interface ChangeWindow {
  start: string;
  end: string;
}

export interface ChangeRecord {
  change_id: string;
  title: string;
  description?: string;
  service?: string;
  status: ChangeStatus;
  window?: ChangeWindow;
  created_at: string;
}

export interface ChangesFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  changes: ChangeRecord[];
}

export interface CalendarFreeze {
  name: string;
  reason?: string;
  start: string;
  end: string;
}

export interface CalendarScheduled {
  change_id: string;
  title: string;
  service?: string;
  window: ChangeWindow;
}

export interface CalendarFixture {
  document: Provenance;
  as_of: string;
  tenant: string;
  coverage_through: string;
  freezes: CalendarFreeze[];
  scheduled: CalendarScheduled[];
}

export interface ItsmFixtures {
  changes: ChangesFixture;
  calendar: CalendarFixture;
}

export function loadItsmFixtures(dir: string = fixturesDir()): ItsmFixtures {
  return {
    changes: readJson(join(dir, 'itsm', 'changes.json')) as unknown as ChangesFixture,
    calendar: readJson(join(dir, 'itsm', 'calendar.json')) as unknown as CalendarFixture,
  };
}
