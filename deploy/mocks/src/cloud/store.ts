/**
 * CloudStore — the stateful core of the cloud-estate mock. ONE instance per
 * process (closed over by main.ts) so tag writes survive the fresh-McpServer-
 * per-POST door and later inventory reads see them (read-your-writes).
 *
 * tag_apply / tag_remove are R2 writes: idempotency-keyed, dry_run-capable,
 * typed errors. tag_apply returns the PREVIOUS value of every key it sets
 * (null when the key was absent) — the honest inverse a compensator needs to
 * restore prior state rather than blindly deleting (design §D4).
 *
 * The read-only query functions (searchInventory, costReport) stay pure; the
 * store exposes a live `fixtures` view whose resource array is the one they
 * read, so an applied tag is visible on the next inventory_search.
 */

import { IdempotencyLedger } from '../shared/idempotency.js';
import type { CloudFixtures, CloudResource } from './fixtures.js';
import type { QueryOutcome } from './queries.js';

const MAX_TAGS_PER_CALL = 10;

interface WritePlan {
  outcome: QueryOutcome;
  commit?: () => void;
  dryData?: Record<string, unknown>;
}

export interface TagApplyArgs {
  resource_id?: string | undefined;
  tags?: Record<string, unknown> | undefined;
  idempotency_key?: string | undefined;
  dry_run?: boolean | undefined;
}

export interface TagRemoveArgs {
  resource_id?: string | undefined;
  keys?: unknown[] | undefined;
  idempotency_key?: string | undefined;
  dry_run?: boolean | undefined;
}

export class CloudStore {
  /** Live view: `inventory.resources` is the mutated array the queries read. */
  readonly fixtures: CloudFixtures;
  private readonly byId: Map<string, CloudResource>;
  private readonly ledger = new IdempotencyLedger<QueryOutcome>();

  constructor(source: CloudFixtures) {
    // Deep-copy resources (and their tag maps) so writes never leak into the
    // loaded fixture object — a second store starts from a clean baseline.
    const resources = source.inventory.resources.map((r) => ({ ...r, tags: { ...r.tags } }));
    this.fixtures = { inventory: { ...source.inventory, resources }, costs: source.costs };
    this.byId = new Map(resources.map((r) => [r.resource_id, r]));
  }

  tagApply(args: TagApplyArgs): QueryOutcome {
    return this.applyWrite('tag_apply', args, () => {
      const resourceId = args.resource_id;
      if (typeof resourceId !== 'string' || resourceId === '') {
        return { outcome: { kind: 'invalid_input', message: 'resource_id is required' } };
      }
      const resource = this.byId.get(resourceId);
      if (resource === undefined) {
        return {
          outcome: { kind: 'not_found', message: `resource ${resourceId} is not in the inventory` },
        };
      }
      const tags = args.tags;
      const entries = tags === undefined ? [] : Object.entries(tags);
      if (entries.length < 1 || entries.length > MAX_TAGS_PER_CALL) {
        return {
          outcome: {
            kind: 'invalid_input',
            message: `tags must map 1..${MAX_TAGS_PER_CALL} keys to string values`,
          },
        };
      }
      if (!entries.every(([, v]) => typeof v === 'string')) {
        return { outcome: { kind: 'invalid_input', message: 'every tag value must be a string' } };
      }
      const applied: Record<string, string> = {};
      const previous: Record<string, string | null> = {};
      for (const [key, value] of entries) {
        previous[key] = resource.tags[key] ?? null;
        applied[key] = value as string;
      }
      return {
        outcome: { kind: 'ok', data: { resource_id: resourceId, applied, previous } },
        commit: () => {
          for (const [key, value] of Object.entries(applied)) resource.tags[key] = value;
        },
        dryData: { resource_id: resourceId, applied, previous, would_change: true },
      };
    });
  }

  tagRemove(args: TagRemoveArgs): QueryOutcome {
    return this.applyWrite('tag_remove', args, () => {
      const resourceId = args.resource_id;
      if (typeof resourceId !== 'string' || resourceId === '') {
        return { outcome: { kind: 'invalid_input', message: 'resource_id is required' } };
      }
      const resource = this.byId.get(resourceId);
      if (resource === undefined) {
        return {
          outcome: { kind: 'not_found', message: `resource ${resourceId} is not in the inventory` },
        };
      }
      const keys = args.keys;
      if (!Array.isArray(keys) || keys.length < 1 || !keys.every((k) => typeof k === 'string')) {
        return {
          outcome: { kind: 'invalid_input', message: 'keys must be a non-empty array of strings' },
        };
      }
      const removed = keys.filter((k) => k in resource.tags);
      const absent = keys.filter((k) => !(k in resource.tags));
      const removedSet = new Set(removed);
      return {
        outcome: { kind: 'ok', data: { resource_id: resourceId, removed, absent } },
        commit: () => {
          // Rebuild the tag map without the removed keys (lint forbids a
          // dynamic delete); the fresh object stays the live-view reference.
          resource.tags = Object.fromEntries(
            Object.entries(resource.tags).filter(([k]) => !removedSet.has(k)),
          );
        },
        dryData: { resource_id: resourceId, removed, absent, would_change: removed.length > 0 },
      };
    });
  }

  private applyWrite(
    tool: string,
    args: { idempotency_key?: string | undefined; dry_run?: boolean | undefined },
    plan: () => WritePlan,
  ): QueryOutcome {
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
