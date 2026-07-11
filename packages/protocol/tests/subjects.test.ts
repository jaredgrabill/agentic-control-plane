import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { subjects } from '../src/index.js';

interface RenderCase {
  entity: string;
  args: Record<string, string>;
  subject?: string;
  why?: string;
}
const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'subjects', 'expected.json'), 'utf8'),
) as { renders: RenderCase[]; rejects: RenderCase[] };

// Dispatches a fixture case to the corresponding builder. Argument order
// mirrors the template token order in subjects.json.
function render(c: RenderCase): string {
  const a = c.args;
  switch (c.entity) {
    case 'task':
      return subjects.task(a.tenant!, a.task_id!, a.verb! as never);
    case 'agent':
      return subjects.agent(a.tenant!, a.agent_id!, a.verb! as never);
    case 'audit':
      return subjects.audit(a.tenant!, a.event_type!);
    case 'audit_corpus':
      return subjects.auditCorpus(a.tenant!, a.source_id!);
    case 'ingest':
      return subjects.ingest(a.tenant!, a.source_id!);
    case 'telemetry':
      return subjects.telemetry(a.tenant!, a.signal!);
    case 'registry':
      return subjects.registry(a.agent_id!, a.verb! as never);
    case 'control':
      return subjects.control(a.verb! as never);
    case 'svc':
      return subjects.svc(a.service! as never, a.method!);
    default:
      throw new Error(`fixture names unknown entity ${c.entity}`);
  }
}

describe('subject vocabulary', () => {
  for (const c of expected.renders) {
    it(`renders ${c.subject}`, () => {
      expect(render(c)).toBe(c.subject);
    });
  }
  for (const c of expected.rejects) {
    it(`rejects ${c.entity}: ${c.why}`, () => {
      expect(() => render(c)).toThrow();
    });
  }
});
