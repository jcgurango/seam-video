import { createHash } from "node:crypto";

/**
 * Content fingerprint of a file — the headless mirror of the web editor's
 * `fingerprint()` (platform/web.ts). SHA-256 over
 * `(size ∥ first 64KB ∥ last 64KB)`: cheap even for large videos, and produces
 * the *same* hash the editor computes client-side, so the two can be compared
 * directly during reconciliation.
 */
const FINGERPRINT_SAMPLE = 64 * 1024;

export function fingerprint(bytes: Buffer): string {
  const size = bytes.length;
  const headLen = Math.min(FINGERPRINT_SAMPLE, size);
  const tailStart = Math.max(headLen, size - FINGERPRINT_SAMPLE);

  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(size), 0);

  const h = createHash("sha256");
  h.update(sizeBuf);
  h.update(bytes.subarray(0, headLen));
  if (tailStart < size) h.update(bytes.subarray(tailStart, size));
  return h.digest("hex");
}
