/**
 * ItsmStore — the stateful core of the itsm mock. ONE instance per process,
 * closed over by the server factory, so mutations (draft creation, submit,
 * withdraw) survive across the fresh-McpServer-per-POST door (shared/http.ts).
 *
 * The store is the reference implementation of the write-tool contract:
 *  - every mutation is idempotency-keyed (retries never double-apply);
 *  - every mutation offers dry_run (full validation, zero mutation);
 *  - a state-machine violation is a typed invalid_input, never a throw.
 *
 * Read tools (change_get, calendar_conflicts) never take an idempotency key
 * and never mutate. Query functions never throw — outcomes are a discriminated
 * union the server maps onto ToolEnvelopes.
 */

import { IdempotencyLedger } from '../shared/idempotency.js';
import type {
  CalendarFixture,
  ChangeRecord,
  ChangeStatus,
  ChangeWindow,
  ItsmFixtures,
} from './fixtures.js';

export type ItsmOutcome =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'invalid_input' | 'not_found'; message: string };

interface WritePlan {
  outcome: ItsmOutcome;
  /** Applied only on the real (non-dry) path when the outcome is ok. */
  commit?: () => void;
  /** The would-be data surfaced under dry_run (defaults to the ok data). */
  dryData?: Record<string, unknown>;
}

const TITLE_MIN = 8;
const TITLE_MAX = 200;
const FIRST_DRAFT_SEQ = 2001;

/** Parse an ISO instant; NaN signals a malformed window bound. */
function instant(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

/** Half-open interval overlap: [a,b) intersects [c,d) iff a < d && c < b. */
function overlaps(a: ChangeWindow, b: ChangeWindow): boolean {
  return instant(a.start) < instant(b.end) && instant(b.start) < instant(a.end);
}

export interface ChangeGetArgs {
  change_id?: string | undefined;
}

export interface ChangeRecordLookupArgs {
  service?: string | undefined;
  deploy_id?: string | undefined;
}

export interface CalendarConflictsArgs {
  window?: ChangeWindow | undefined;
  service?: string | undefined;
}

export interface CreateDraftArgs {
  title?: string | undefined;
  description?: string | undefined;
  service?: string | undefined;
  window?: ChangeWindow | undefined;
  idempotency_key?: string | undefined;
  dry_run?: boolean | undefined;
}

export interface ChangeIdWriteArgs {
  change_id?: string | undefined;
  reason?: string | undefined;
  idempotency_key?: string | undefined;
  dry_run?: boolean | undefined;
}

export class ItsmStore {
  private readonly changes = new Map<string, ChangeRecord>();
  private readonly calendar: CalendarFixture;
  private readonly ledger = new IdempotencyLedger<ItsmOutcome>();
  private nextDraftSeq = FIRST_DRAFT_SEQ;
  private readonly now: () => string;

  constructor(fixtures: ItsmFixtures, options: { now?: () => string } = {}) {
    // Deep-copy the fixture records so mutations never leak into the loaded
    // fixture object (a second store gets a clean baseline).
    for (const record of fixtures.changes.changes) {
      this.changes.set(record.change_id, { ...record });
    }
    this.calendar = fixtures.calendar;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---- read tools -------------------------------------------------------

  changeGet(args: ChangeGetArgs): ItsmOutcome {
    const id = args.change_id;
    if (typeof id !== 'string' || id === '') {
      return { kind: 'invalid_input', message: 'change_id is required' };
    }
    const record = this.changes.get(id);
    if (record === undefined) {
      return { kind: 'not_found', message: `change ${id} is not in the change log` };
    }
    return { kind: 'ok', data: { change: { ...record } } };
  }

  /**
   * Read tool: find change records by service and/or deploy_id (at least one
   * filter — an unfiltered dump of the change log is not a lookup). A
   * covered-but-empty match is `ok` with an empty list so a caller can tell a
   * genuine "no linked change" from a coverage miss; it never mutates.
   */
  changeRecordLookup(args: ChangeRecordLookupArgs): ItsmOutcome {
    const service = args.service;
    const deployId = args.deploy_id;
    if (
      (typeof service !== 'string' || service === '') &&
      (typeof deployId !== 'string' || deployId === '')
    ) {
      return {
        kind: 'invalid_input',
        message: 'provide at least one of service or deploy_id',
      };
    }
    const matched = [...this.changes.values()]
      .filter(
        (r) =>
          (service === undefined || service === '' || r.service === service) &&
          (deployId === undefined || deployId === '' || r.deploy_id === deployId),
      )
      .map((r) => ({ ...r }));
    return {
      kind: 'ok',
      data: {
        ...(service === undefined || service === '' ? {} : { service }),
        ...(deployId === undefined || deployId === '' ? {} : { deploy_id: deployId }),
        changes: matched,
        total_matched: matched.length,
      },
    };
  }

  calendarConflicts(args: CalendarConflictsArgs): ItsmOutcome {
    const window = args.window;
    if (
      window === undefined ||
      typeof window.start !== 'string' ||
      typeof window.end !== 'string'
    ) {
      return { kind: 'invalid_input', message: 'window with start and end (ISO 8601) is required' };
    }
    if (Number.isNaN(instant(window.start)) || Number.isNaN(instant(window.end))) {
      return {
        kind: 'invalid_input',
        message: 'window.start and window.end must be ISO 8601 instants',
      };
    }
    if (instant(window.start) >= instant(window.end)) {
      return { kind: 'invalid_input', message: 'window.start must be before window.end' };
    }

    const service = args.service;
    const conflicts = this.calendar.scheduled
      .filter((s) => (service === undefined || s.service === service) && overlaps(window, s.window))
      .map((s) => ({
        change_id: s.change_id,
        title: s.title,
        ...(s.service === undefined ? {} : { service: s.service }),
        window: s.window,
      }));
    const freezes = this.calendar.freezes
      .filter((f) => overlaps(window, { start: f.start, end: f.end }))
      .map((f) => ({
        name: f.name,
        ...(f.reason === undefined ? {} : { reason: f.reason }),
        start: f.start,
        end: f.end,
      }));

    const withinCoverage = instant(window.end) <= instant(this.calendar.coverage_through);
    return {
      kind: 'ok',
      data: {
        window,
        ...(service === undefined ? {} : { service }),
        coverage_through: this.calendar.coverage_through,
        within_coverage: withinCoverage,
        conflicts,
        freezes,
      },
    };
  }

  // ---- write tools ------------------------------------------------------

  createDraft(args: CreateDraftArgs): ItsmOutcome {
    return this.applyWrite('change_create_draft', args, () => {
      const title = args.title;
      if (typeof title !== 'string' || title.length < TITLE_MIN || title.length > TITLE_MAX) {
        return {
          outcome: {
            kind: 'invalid_input',
            message: `title must be a string of ${TITLE_MIN}..${TITLE_MAX} characters`,
          },
        };
      }
      const changeId = `CHG-${this.nextDraftSeq}`;
      const record: ChangeRecord = {
        change_id: changeId,
        title,
        status: 'draft',
        created_at: this.now(),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.service === undefined ? {} : { service: args.service }),
        ...(args.window === undefined ? {} : { window: args.window }),
      };
      const okData: Record<string, unknown> = {
        change_id: changeId,
        status: 'draft',
        title,
        ...(args.service === undefined ? {} : { service: args.service }),
        ...(args.window === undefined ? {} : { window: args.window }),
      };
      return {
        outcome: { kind: 'ok', data: okData },
        commit: () => {
          this.nextDraftSeq += 1;
          this.changes.set(changeId, record);
        },
        // dry_run reserves NO id — the would-be outcome omits change_id.
        dryData: {
          status: 'draft',
          title,
          ...(args.service === undefined ? {} : { service: args.service }),
          ...(args.window === undefined ? {} : { window: args.window }),
        },
      };
    });
  }

  submit(args: ChangeIdWriteArgs): ItsmOutcome {
    return this.applyWrite('change_submit', args, () =>
      this.transition(args.change_id, 'draft', 'submitted', 'submit'),
    );
  }

  withdraw(args: ChangeIdWriteArgs): ItsmOutcome {
    return this.applyWrite('change_withdraw', args, () =>
      this.transition(args.change_id, 'submitted', 'withdrawn', 'withdraw'),
    );
  }

  private transition(
    changeId: string | undefined,
    from: ChangeStatus,
    to: ChangeStatus,
    verb: string,
  ): WritePlan {
    if (typeof changeId !== 'string' || changeId === '') {
      return { outcome: { kind: 'invalid_input', message: 'change_id is required' } };
    }
    const record = this.changes.get(changeId);
    if (record === undefined) {
      return {
        outcome: { kind: 'not_found', message: `change ${changeId} is not in the change log` },
      };
    }
    if (record.status !== from) {
      return {
        outcome: {
          kind: 'invalid_input',
          message: `change ${changeId} cannot be ${verb}n from status ${record.status} — only a ${from} change may be ${verb}n`,
        },
      };
    }
    const data: Record<string, unknown> = {
      change_id: changeId,
      status: to,
      previous_status: from,
      title: record.title,
    };
    return {
      outcome: { kind: 'ok', data },
      commit: () => {
        record.status = to;
      },
    };
  }

  /**
   * The write envelope shared by every mutation: dry_run validates without
   * mutating or touching the ledger; otherwise idempotency is consulted
   * (replay stored ok result / reject a key reused with different args / run),
   * and only a successful result is committed to the ledger and the store.
   */
  private applyWrite(
    tool: string,
    args: { idempotency_key?: string | undefined; dry_run?: boolean | undefined },
    plan: () => WritePlan,
  ): ItsmOutcome {
    if (args.dry_run === true) {
      const planned = plan();
      if (planned.outcome.kind !== 'ok') return planned.outcome;
      return { kind: 'ok', data: { dry_run: true, ...(planned.dryData ?? planned.outcome.data) } };
    }

    const key = args.idempotency_key;
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      return {
        kind: 'invalid_input',
        message: 'idempotency_key is required for a write and must be 8..128 characters',
      };
    }
    const look = this.ledger.lookup(tool, key, args);
    if (look.status === 'replay') return look.result;
    if (look.status === 'conflict') {
      return {
        kind: 'invalid_input',
        message: `idempotency key ${key} was already used for a different ${tool} call (different arguments)`,
      };
    }
    const planned = plan();
    if (planned.outcome.kind === 'ok') {
      planned.commit?.();
      this.ledger.commit(tool, key, args, planned.outcome);
    }
    return planned.outcome;
  }
}
