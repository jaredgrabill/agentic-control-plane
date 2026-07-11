import { createHash } from 'node:crypto';

/**
 * Canonical audit digest: audit records carry digests, not payloads, so
 * the trail can be retained for years without retaining the data itself.
 */
export function sha256Digest(input: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}
