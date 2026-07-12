import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + version/variant bits +
 * randomness. Time-ordered, so the lineage id itself embeds when the
 * corpus changed, and index-friendly in Postgres and the ledger
 * (knowledge-and-rag.md).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = Uint8Array.from(randomBytes(16));
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
