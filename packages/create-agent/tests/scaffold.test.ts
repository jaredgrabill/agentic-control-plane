import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentManifest } from '@acp/protocol';
import { Agent, CapabilityError, ErrorClass, EvalHarness, loadGolden } from '@acp/agent-sdk';
import { scaffold } from '../src/scaffold.js';
import { renderTemplate } from '../src/template.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-scaffold-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function stderrOutput(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => String(call[0]))
    .join('');
}

describe('scaffold', () => {
  it('scaffolds the full anatomy', () => {
    expect(scaffold(['incident-summary-agent', '--dir', dir, '--owner', 'team-ops'])).toBe(0);
    const root = join(dir, 'incident-summary-agent');
    for (const required of [
      'manifest.yaml',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'vitest.config.ts',
      'src/main.ts',
      'src/capabilities/hello.ts',
      'src/prompts/README.md',
      'evals/golden/cases.json',
      'evals/rubrics/README.md',
      'evals/redteam/cases.json',
      'tests/evals.test.ts',
      'README.md',
    ]) {
      expect(existsSync(join(root, required)), `missing ${required}`).toBe(true);
    }
  });

  it('rejects bad names, existing dirs, and unknown flags', () => {
    expect(scaffold(['Not_Kebab', '--dir', dir])).toBe(2);
    expect(stderrOutput()).toContain('must be kebab-case');

    expect(scaffold(['twice-agent', '--dir', dir])).toBe(0);
    expect(scaffold(['twice-agent', '--dir', dir])).toBe(2);
    expect(stderrOutput()).toContain('refusing to overwrite');

    expect(scaffold(['ok-agent', '--dir', dir, '--unknown', 'flag'])).toBe(2);
    expect(scaffold([])).toBe(2);
    expect(scaffold(['one-agent', 'two-agent', '--dir', dir])).toBe(2);
  });
});

describe('renderTemplate', () => {
  const files = renderTemplate('incident-summary-agent', 'team-ops');

  it('renders a manifest that conforms to the protocol schema', () => {
    const manifest = agentManifest.parse(YAML.parse(files['manifest.yaml']!));
    expect(manifest.owner).toBe('team-ops');
    expect(manifest.capabilities[0].name).toBe('incident_summary.hello');
  });

  it('renders TypeScript that parses and JSON that parses', () => {
    for (const [rel, content] of Object.entries(files)) {
      if (rel.endsWith('.ts')) {
        const source = ts.createSourceFile(rel, content, ts.ScriptTarget.ES2022, true);
        const diagnostics = (source as unknown as { parseDiagnostics?: { messageText: unknown }[] })
          .parseDiagnostics;
        expect(diagnostics ?? [], `parse errors in ${rel}`).toEqual([]);
      }
      if (rel.endsWith('.json')) {
        expect(() => void JSON.parse(content)).not.toThrow();
      }
    }
  });

  it('keeps the domain prefix when the name has no -agent suffix', () => {
    const bare = renderTemplate('notes', 'team-x');
    expect(bare['manifest.yaml']).toContain('name: notes.hello');
  });

  it('generated golden and redteam suites pass through the EvalHarness', async () => {
    // The two-line hello handler, re-implemented against the rendered
    // manifest — the behavioral contract the generated code must satisfy
    // (the Python twin execs the rendered handler itself).
    const agent = new Agent({ manifest: agentManifest.parse(YAML.parse(files['manifest.yaml']!)) });
    agent.capability('incident_summary.hello', (_ctx, input) => {
      const audience = typeof input.audience === 'string' ? input.audience : '';
      if (audience === '') {
        return Promise.reject(new CapabilityError(ErrorClass.NeedsInput, 'audience is required'));
      }
      const builder = agent.answerBuilder();
      builder.paragraph(`Hello, ${audience}! This is incident-summary-agent reporting for duty.`);
      return Promise.resolve({ ...builder.build(0.99) });
    });

    for (const suite of ['golden', 'redteam'] as const) {
      const suiteDir = join(dir, suite);
      mkdirSync(suiteDir, { recursive: true });
      writeFileSync(join(suiteDir, 'cases.json'), files[`evals/${suite}/cases.json`]!, 'utf-8');
      const report = await new EvalHarness(agent).run(loadGolden(suiteDir));
      expect(report.passed, `${suite}: ${report.summary()}`).toBe(true);
    }
  });
});
