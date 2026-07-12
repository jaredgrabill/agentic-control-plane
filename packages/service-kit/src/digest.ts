import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` values
 * dropped. Digest and signature payloads must not depend on property
 * insertion order, or the same logical value hashes differently across
 * runtimes. Shared by the registry card signature, the approval subject
 * digest, and audit hash-chain canonicalization (three consumers — hence
 * service-kit).
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical audit digest: audit records carry digests, not payloads, so
 * the trail can be retained for years without retaining the data itself.
 */
export function sha256Digest(input: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}
