import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The breaking-change gate lives at the repo root (scripts/schema-diff.mjs) so
// it can run in CI without a workspace build; we exercise its pure diff core here.
import {
  diffBundles,
  readCurrentBundle,
  type DiffFinding,
  type SchemaBundle,
} from '../../../scripts/schema-diff.mjs';

const fixtures = join(import.meta.dirname, 'fixtures', 'schema-diff');
const load = (name: string): SchemaBundle =>
  JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as SchemaBundle;
const render = (findings: DiffFinding[]): string[] => findings.map((f) => `${f.path}: ${f.msg}`);

describe('schema-diff gate', () => {
  it('flags every breaking change class against the baseline', () => {
    const { breaking, additive } = diffBundles(load('baseline'), load('breaking'));
    const msgs = render(breaking);
    // A newly-required field, a removed enum value, a removed property, and a
    // removed subject verb must each be caught — the four ways the frozen wire
    // contract regresses in the fixture.
    expect(msgs).toContain('widget: required field added: label');
    expect(msgs).toContain('widget.kind: enum value removed: "gamma"');
    expect(msgs).toContain('widget: property removed: count');
    expect(msgs).toContain('subjects.widget: verb removed: updated');
    expect(breaking.length).toBe(4);
    expect(additive.length).toBe(0);
  });

  it('treats new optional fields, enum values, and subjects as additive', () => {
    const { breaking, additive } = diffBundles(load('baseline'), load('additive'));
    expect(breaking).toHaveLength(0);
    const msgs = render(additive);
    expect(msgs).toContain('widget.kind: enum value added: "delta"');
    expect(msgs).toContain('widget: property added: note');
    expect(msgs).toContain('subjects.widget: verb added: deleted');
  });

  it('flags a constraint ADDED to a previously free-form field as breaking', () => {
    const bundle = (props: Record<string, unknown>): SchemaBundle => ({
      schemas: {
        'w.schema.json': { type: 'object', additionalProperties: false, properties: props },
      },
      subjects: { version: 1, entities: {} },
    });
    // Baseline: a/b/c accept a superset; narrowing them by adding a type, enum,
    // or pattern rejects previously-valid documents = breaking (not additive).
    const base = bundle({ a: {}, b: { type: 'string' }, c: { type: 'string' } });
    const narrowed = bundle({
      a: { type: 'string' },
      b: { type: 'string', enum: ['x', 'y'] },
      c: { type: 'string', pattern: '^[a-z]+$' },
    });
    const msgs = diffBundles(base, narrowed).breaking.map((f) => f.msg);
    expect(msgs).toContain('type constraint added: "string"');
    expect(msgs.some((m) => m.startsWith('enum constraint added'))).toBe(true);
    expect(msgs).toContain('pattern constraint added');
  });

  it('the committed baseline matches the live protocol surface (no drift)', () => {
    // The gate that guards a no-change PR: the frozen baseline must equal what
    // `pnpm gen` reads today, or every unrelated PR would trip the gate.
    const baseline = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'schema-baseline.json'), 'utf8'),
    ) as SchemaBundle;
    const { breaking, additive } = diffBundles(baseline, readCurrentBundle());
    expect(breaking).toHaveLength(0);
    expect(additive).toHaveLength(0);
  });
});
