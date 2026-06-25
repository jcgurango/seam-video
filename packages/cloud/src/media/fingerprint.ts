import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/**
 * Content fingerprint of a file — the headless mirror of the web editor's
 * `fingerprint()` (platform/web.ts). SHA-256 over
 * `(size ∥ first 64KB ∥ last 64KB)`: cheap even for large videos, and produces
 * the *same* hash the editor computes client-side, so the two can be compared
 * directly during reconciliation.
 */
export const FINGERPRINT_SAMPLE = 64 * 1024;

export function fingerprint(bytes: Buffer): string {
  const size = bytes.length;
  const headLen = Math.min(FINGERPRINT_SAMPLE, size);
  const tailStart = Math.max(headLen, size - FINGERPRINT_SAMPLE);
  const head = bytes.subarray(0, headLen);
  const tail = tailStart < size ? bytes.subarray(tailStart, size) : Buffer.alloc(0);
  return fingerprintParts(size, head, tail);
}

/**
 * The hash from its parts: total `size`, the first ≤64KB (`head`) and the last
 * ≤64KB (`tail`). Lets a consumer that only fetched the two sample ranges of a
 * large remote file (e.g. an Immich asset over HTTP Range) compute the *same*
 * digest {@link fingerprint} produces over the whole buffer.
 *
 * For `size > 2·64KB` head and tail don't overlap (a middle gap is skipped);
 * for smaller sizes the caller must pass non-overlapping head/tail that
 * together cover the file, exactly as {@link fingerprint} slices them.
 */
export function fingerprintParts(
  size: number,
  head: Uint8Array,
  tail: Uint8Array
): string {
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(size), 0);
  const h = createHash("sha256");
  h.update(sizeBuf);
  h.update(head);
  if (tail.length > 0) h.update(tail);
  return h.digest("hex");
}

/**
 * Fingerprint a file on disk by reading only its head + tail ranges (never the
 * whole file into memory) — for streamed uploads that were written to disk
 * before hashing. Matches {@link fingerprint} over the same bytes.
 */
export async function fingerprintFile(
  path: string
): Promise<{ hash: string; size: number }> {
  const { size } = await fs.stat(path);
  const { headLen, tailStart } = fingerprintRanges(size);
  const fh = await fs.open(path, "r");
  try {
    const head = Buffer.alloc(headLen);
    if (headLen > 0) await fh.read(head, 0, headLen, 0);
    let tail = Buffer.alloc(0);
    if (tailStart < size) {
      tail = Buffer.alloc(size - tailStart);
      await fh.read(tail, 0, tail.length, tailStart);
    }
    return { hash: fingerprintParts(size, head, tail), size };
  } finally {
    await fh.close();
  }
}

/** The byte ranges {@link fingerprint} samples for a file of `size` bytes:
 *  `[0, head)` and `[tailStart, size)`. `tailStart === size` ⇒ no tail. */
export function fingerprintRanges(size: number): {
  headLen: number;
  tailStart: number;
} {
  const headLen = Math.min(FINGERPRINT_SAMPLE, size);
  const tailStart = Math.max(headLen, size - FINGERPRINT_SAMPLE);
  return { headLen, tailStart };
}
