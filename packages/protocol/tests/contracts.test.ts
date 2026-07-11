import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentCard,
  agentManifest,
  auditEvent,
  evalReport,
  taskMessage,
  ProtocolValidationError,
} from '../src/index.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

interface Case {
  file: string;
  schema: 'agent-manifest' | 'agent-card' | 'task-contract' | 'audit-event' | 'eval-report';
  valid: boolean;
}
const { cases } = JSON.parse(readFileSync(join(fixturesDir, 'expectations.json'), 'utf8')) as {
  cases: Case[];
};

const parsers = {
  'agent-manifest': agentManifest,
  'agent-card': agentCard,
  'task-contract': taskMessage,
  'audit-event': auditEvent,
  'eval-report': evalReport,
} as const;

describe('shared contract fixtures', () => {
  it('covers every schema with valid and invalid cases', () => {
    for (const schema of Object.keys(parsers) as (keyof typeof parsers)[]) {
      expect(cases.some((c) => c.schema === schema && c.valid)).toBe(true);
      expect(cases.some((c) => c.schema === schema && !c.valid)).toBe(true);
    }
  });

  for (const c of cases) {
    it(`${c.file} is ${c.valid ? 'accepted' : 'rejected'}`, () => {
      const doc: unknown = JSON.parse(readFileSync(join(fixturesDir, c.file), 'utf8'));
      const parser = parsers[c.schema];
      expect(parser.validate(doc)).toBe(c.valid);
      if (c.valid) {
        expect(parser.errors(doc)).toEqual([]);
        expect(parser.parse(doc)).toBe(doc);
      } else {
        expect(parser.errors(doc).length).toBeGreaterThan(0);
        expect(() => parser.parse(doc)).toThrow(ProtocolValidationError);
      }
    });
  }
});
