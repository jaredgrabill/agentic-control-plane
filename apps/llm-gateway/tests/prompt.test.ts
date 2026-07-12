import { describe, expect, it } from 'vitest';
import type { PromptBlock } from '@acp/llm-client';
import { estimateTokens, prefixDigestOf, stableStringify, validatePrompt } from '../src/prompt.js';

const system: PromptBlock = { role: 'system', text: 'You are a careful analyst.' };
const user: PromptBlock = { role: 'user', text: 'What changed?' };

describe('validatePrompt', () => {
  it('assembles strictly static ++ variable, order preserved', () => {
    const result = validatePrompt({
      static: [system, { role: 'user', text: 'tool schemas here' }],
      variable: [{ role: 'assistant', text: 'previous turn' }, user],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.blocks.map((b) => b.text)).toEqual([
      'You are a careful analyst.',
      'tool schemas here',
      'previous turn',
      'What changed?',
    ]);
    expect(result.prompt.staticBlocks).toHaveLength(2);
    expect(result.prompt.variableBlocks).toHaveLength(2);
  });

  it('estimates tokens at ceil(chars/4) per block, summed per section', () => {
    const result = validatePrompt({ static: [system], variable: [user] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.staticTokensEstimate).toBe(estimateTokens(system.text));
    expect(result.prompt.variableTokensEstimate).toBe(estimateTokens(user.text));
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('refuses more than 4 static blocks and more than 32 total', () => {
    const five = Array.from({ length: 5 }, () => system);
    const overStatic = validatePrompt({ static: five, variable: [user] });
    expect(overStatic.ok).toBe(false);
    if (overStatic.ok) return;
    expect(overStatic.violations[0]).toContain('capped at 4');

    const thirty = Array.from({ length: 33 }, () => user);
    const overTotal = validatePrompt({ static: [], variable: thirty });
    expect(overTotal.ok).toBe(false);
    if (overTotal.ok) return;
    expect(overTotal.violations[0]).toContain('the cap is 32');
  });

  it('refuses empty variable sections, empty text, and unknown roles', () => {
    expect(validatePrompt({ static: [system], variable: [] }).ok).toBe(false);
    expect(validatePrompt({ static: [], variable: [{ role: 'user', text: '' }] }).ok).toBe(false);
    const badRole = validatePrompt({
      static: [],
      variable: [{ role: 'tool' as PromptBlock['role'], text: 'x' }],
    });
    expect(badRole.ok).toBe(false);
    if (badRole.ok) return;
    expect(badRole.violations[0]).toContain('must be system, user, or assistant');
  });
});

describe('prefix digest', () => {
  it('is stable across calls and insensitive to key order', () => {
    const a = prefixDigestOf([{ role: 'system', text: 'stable' }]);
    const b = prefixDigestOf([JSON.parse('{"text":"stable","role":"system"}') as PromptBlock]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when the static content changes, ignores the variable tail entirely', () => {
    const first = validatePrompt({ static: [system], variable: [user] });
    const second = validatePrompt({
      static: [system],
      variable: [{ role: 'user', text: 'a completely different question' }],
    });
    const third = validatePrompt({
      static: [{ role: 'system', text: 'You are a different analyst.' }],
      variable: [user],
    });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(first.prompt.prefixDigest).toBe(second.prompt.prefixDigest);
    expect(first.prompt.prefixDigest).not.toBe(third.prompt.prefixDigest);
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively and drops undefined values', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 3, y: 4 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":4,"z":3}]},"b":1}',
    );
    expect(stableStringify('text')).toBe('"text"');
    expect(stableStringify(null)).toBe('null');
  });
});
