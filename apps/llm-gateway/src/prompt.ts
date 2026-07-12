/**
 * Prompt-caching layout, enforced by construction (cost-management.md
 * lever 1): assembly is strictly `static ++ variable`, order preserved and
 * byte-stable, so the cacheable prefix is identical across calls whenever
 * the static blocks are. The prefix digest is the observable: it feeds the
 * `acp.llm.prefix_digest` span attribute and the per-(caller, class)
 * stability signal behind the cache-hit-rate dashboards.
 */

import { createHash } from 'node:crypto';
import type { CompletionPrompt, PromptBlock } from '@acp/llm-client';

export const MAX_STATIC_BLOCKS = 4;
export const MAX_TOTAL_BLOCKS = 32;
const ROLES = new Set(['system', 'user', 'assistant']);

export interface ValidatedPrompt {
  /** The assembled prompt: static blocks first, then variable, order preserved. */
  blocks: PromptBlock[];
  staticBlocks: PromptBlock[];
  variableBlocks: PromptBlock[];
  /** sha256 over the stable serialization of the static blocks. */
  prefixDigest: string;
  staticTokensEstimate: number;
  variableTokensEstimate: number;
}

export type PromptValidation =
  { ok: true; prompt: ValidatedPrompt } | { ok: false; violations: string[] };

/** ceil(chars / 4) — the dev provider's and cache-threshold's token estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Deterministic JSON: keys sorted recursively, no whitespace. Two
 * structurally identical static sections MUST digest identically no matter
 * which SDK or language serialized them.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function prefixDigestOf(staticBlocks: PromptBlock[]): string {
  return `sha256:${createHash('sha256').update(stableStringify(staticBlocks)).digest('hex')}`;
}

export function validatePrompt(prompt: CompletionPrompt): PromptValidation {
  const violations: string[] = [];
  if (prompt.static.length > MAX_STATIC_BLOCKS) {
    violations.push(
      `prompt.static has ${prompt.static.length} blocks — the stable prefix is capped at ${MAX_STATIC_BLOCKS}`,
    );
  }
  if (prompt.variable.length < 1) {
    violations.push('prompt.variable must carry at least one block');
  }
  const total = prompt.static.length + prompt.variable.length;
  if (total > MAX_TOTAL_BLOCKS) {
    violations.push(`prompt has ${total} blocks total — the cap is ${MAX_TOTAL_BLOCKS}`);
  }
  for (const [section, blocks] of [
    ['static', prompt.static],
    ['variable', prompt.variable],
  ] as const) {
    blocks.forEach((block, index) => {
      if (!ROLES.has(block.role)) {
        violations.push(`prompt.${section}[${index}].role must be system, user, or assistant`);
      }
      if (typeof block.text !== 'string' || block.text === '') {
        violations.push(`prompt.${section}[${index}].text must be a non-empty string`);
      }
    });
  }
  if (violations.length > 0) return { ok: false, violations };

  const staticBlocks = prompt.static.map((b) => ({ role: b.role, text: b.text }));
  const variableBlocks = prompt.variable.map((b) => ({ role: b.role, text: b.text }));
  return {
    ok: true,
    prompt: {
      blocks: [...staticBlocks, ...variableBlocks],
      staticBlocks,
      variableBlocks,
      prefixDigest: prefixDigestOf(staticBlocks),
      staticTokensEstimate: staticBlocks.reduce((sum, b) => sum + estimateTokens(b.text), 0),
      variableTokensEstimate: variableBlocks.reduce((sum, b) => sum + estimateTokens(b.text), 0),
    },
  };
}
