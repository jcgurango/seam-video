/**
 * Classify a `static` source by its leading bytes (`sniffStaticKind` from
 * `@seam/media-source`), never by its name — a remote .seam's sources are
 * `…/api/media/<id>/file?token=…` with no extension. Local paths read the
 * head off disk; `http(s)` URLs ask for a bounded Range and take the first
 * body chunk (a server that ignores Range and answers 200 still only costs
 * one chunk — the body is cancelled).
 */
import { open } from "node:fs/promises";
import { SNIFF_BYTES, sniffStaticKind, type StaticKind } from "@seam/media-source";
import { isRemoteSource } from "./mediaInput.js";

export async function readStaticHead(pathOrUrl: string): Promise<Uint8Array> {
  if (isRemoteSource(pathOrUrl)) {
    const res = await fetch(pathOrUrl, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } });
    if (!res.ok) throw new Error(`static source ${res.status} ${res.statusText}`);
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < SNIFF_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(got, SNIFF_BYTES));
    let off = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, out.length - off);
      out.set(c.subarray(0, n), off);
      off += n;
      if (off >= out.length) break;
    }
    return out;
  }
  const fh = await open(pathOrUrl, "r");
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function classifyStatic(pathOrUrl: string): Promise<StaticKind> {
  return sniffStaticKind(await readStaticHead(pathOrUrl));
}
