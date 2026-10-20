import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { BlockStores, INDEX_TAG, LIVE_TAG } from "../blockStore.js";

const SIZE = 5 * (1 << 20);
const BLOCK = 64 * 1024;
const data = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = (i * 31 + 7) & 0xff;

let server: Server;
let url: string;
let ranges: string[] = [];
let failNext = 0; // number of upcoming requests to answer with 500
let ignoreRange = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range ?? "";
    ranges.push(range);
    setTimeout(() => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(500);
        res.end();
        return;
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m || ignoreRange) {
        res.writeHead(200, { "content-length": SIZE, "accept-ranges": "bytes" });
        res.end(Buffer.from(data));
        return;
      }
      const start = Number(m[1]);
      if (start >= SIZE) {
        res.writeHead(416, { "content-range": `bytes */${SIZE}` });
        res.end();
        return;
      }
      const end = Math.min(m[2] ? Number(m[2]) : SIZE - 1, SIZE - 1);
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${SIZE}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
      });
      res.end(Buffer.from(data.subarray(start, end + 1)));
    }, 3);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/f.bin`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function fresh(opts: ConstructorParameters<typeof BlockStores>[0] = {}) {
  ranges = [];
  return new BlockStores({ blockSize: BLOCK, maxRequestBytes: 4 * BLOCK, readAhead: false, protectRecentBlocks: 0, ...opts });
}

const expectBytes = (got: Uint8Array, start: number, end: number) => {
  expect(got.length).toBe(end - start);
  expect(Buffer.compare(Buffer.from(got), Buffer.from(data.subarray(start, end)))).toBe(0);
};

describe("BlockStore", () => {
  it("reads are byte-exact across block boundaries and every request is bounded", async () => {
    const stores = fresh();
    const s = stores.get(url);
    expect(await s.size()).toBe(SIZE);
    const reads: [number, number][] = [
      [0, 1],
      [BLOCK - 10, BLOCK + 10],
      [3 * BLOCK + 5, 6 * BLOCK - 5],
      [SIZE - 100, SIZE],
      [1234567, 1234567 + 777],
    ];
    for (const [a, b] of reads) expectBytes(await s.read(a, b, LIVE_TAG), a, b);
    for (const r of ranges) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(r);
      expect(m, `unbounded or missing range: ${r}`).not.toBeNull();
      expect(Number(m![2])).toBeLessThan(SIZE);
    }
    await expect(s.read(SIZE - 1, SIZE + 1, LIVE_TAG)).rejects.toThrow(RangeError);
    stores.dispose();
  });

  it("coalesces adjacent missing blocks into capped requests", async () => {
    const stores = fresh();
    const s = stores.get(url);
    await s.size(); // 1 request (block 0, pinned index)
    expectBytes(await s.read(0, 16 * BLOCK, "a"), 0, 16 * BLOCK);
    // blocks 1..15 missing → runs of ≤4 blocks: 15 = 4+4+4+3 → 4 requests
    expect(ranges.length).toBe(1 + 4);
    expect(ranges[1]).toBe(`bytes=${BLOCK}-${5 * BLOCK - 1}`);
    stores.dispose();
  });

  it("dedupes concurrent fetches of the same block", async () => {
    const stores = fresh();
    const s = stores.get(url);
    await s.size();
    const n = ranges.length;
    const [x, y, z] = await Promise.all([
      s.read(20 * BLOCK, 21 * BLOCK, "a"),
      s.read(20 * BLOCK + 100, 20 * BLOCK + 200, "b"),
      s.read(20 * BLOCK, 20 * BLOCK + 1, "c"),
    ]);
    expectBytes(x, 20 * BLOCK, 21 * BLOCK);
    expectBytes(y, 20 * BLOCK + 100, 20 * BLOCK + 200);
    expectBytes(z, 20 * BLOCK, 20 * BLOCK + 1);
    expect(ranges.length - n).toBe(1);
    expect(stores.stats().requests).toBe(n + 1);
    stores.dispose();
  });

  it("evicts by priority (highest first, LRU within) and never the index", async () => {
    const stores = fresh({ budgetBytes: 8 * BLOCK });
    const prio: Record<string, number> = { far: 100, near: 1 };
    stores.setPriority((t) => prio[t] ?? 50);
    const s = stores.get(url);
    await s.size();
    for (let i = 1; i <= 5; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, "far");
    expect(stores.usedBytes).toBe(6 * BLOCK);
    for (let i = 10; i <= 15; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, "near");
    // Over budget (12 blocks > 8) → evicted down to ≤ 90% → 7 blocks; the
    // five 'far' blocks go first (oldest first), index + all 'near' stay.
    expect(stores.usedBytes).toBeLessThanOrEqual(8 * BLOCK);
    expect(s.coverage("near")).toBe(1);
    expect(s.coverage("far")).toBeLessThan(1);
    const before = stores.stats().requests;
    await s.read(0, 10, LIVE_TAG); // index still resident → no request
    expect(stores.stats().requests).toBe(before);
    stores.dispose();
  });

  it("read-ahead warms following blocks on a sequential pattern", async () => {
    const stores = fresh({ readAhead: true, maxReadAheadBlocks: 4 });
    const s = stores.get(url);
    await s.size();
    for (let i = 1; i <= 3; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, "seq");
    await new Promise((r) => setTimeout(r, 60));
    const before = stores.stats();
    expectBytes(await s.read(4 * BLOCK, 6 * BLOCK, "seq"), 4 * BLOCK, 6 * BLOCK);
    const after = stores.stats();
    // Both blocks were already resident (the read never waited on the
    // network); the read itself kicks off the *next* read-ahead, which is
    // why `requests` may still grow.
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(2); // + the read-ahead's own hits
    expect(after.misses - before.misses).toBe(0);
    stores.dispose();
  });

  it("learns a tag's span and folds live reads inside it onto the tag", async () => {
    const stores = fresh({ budgetBytes: 6 * BLOCK });
    let cutAFar = true; // phase 1: cutA is far (evict first); phase 2: near
    stores.setPriority((t) => (t === "cutA" ? (cutAFar ? 100 : 1) : 50));
    const s = stores.get(url);
    await s.size();
    await s.read(10 * BLOCK + 5, 13 * BLOCK - 5, "cutA");
    expect(s.rangeOf("cutA")).toEqual({ first: 10, last: 12 });
    expect(s.rangeOf(LIVE_TAG)).toBeNull();
    // Flood with live reads: cutA (far) is evicted first.
    for (let i = 30; i < 36; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, LIVE_TAG);
    expect(s.coverage("cutA")).toBeLessThan(1);
    // Now cutA is near. A live read back inside its learned span is
    // attributed to cutA (priority 1), so the next flood evicts the plain
    // live blocks (50) and keeps it resident.
    cutAFar = false;
    await s.read(11 * BLOCK, 12 * BLOCK, LIVE_TAG);
    for (let i = 40; i < 46; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, LIVE_TAG);
    const before = stores.stats().requests;
    await s.read(11 * BLOCK, 11 * BLOCK + 1, LIVE_TAG);
    expect(stores.stats().requests).toBe(before);
    stores.dispose();
  });

  it("never evicts the most recently used blocks (no thrash under a tight budget)", async () => {
    const stores = fresh({ budgetBytes: 4 * BLOCK, protectRecentBlocks: 3 });
    stores.setPriority(() => 100); // everything equally disposable
    const s = stores.get(url);
    await s.size();
    for (let i = 1; i <= 8; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, LIVE_TAG);
    // Budget 4 blocks, index pinned → nominally 3 slots; the last 3 reads
    // are protected, so re-reading them costs nothing.
    const before = stores.stats();
    for (let i = 6; i <= 8; i++) await s.read(i * BLOCK, (i + 1) * BLOCK, LIVE_TAG);
    const after = stores.stats();
    expect(after.requests).toBe(before.requests);
    expect(after.misses).toBe(before.misses);
    stores.dispose();
  });

  it("retries a 5xx and surfaces a server that ignores Range", async () => {
    const stores = fresh();
    const s = stores.get(url);
    failNext = 1;
    expect(await s.size()).toBe(SIZE);
    expect(ranges.length).toBe(2);
    stores.dispose();

    const stores2 = fresh();
    ignoreRange = true;
    try {
      await expect(stores2.get(url).size()).rejects.toThrow(/ignored the Range header/);
    } finally {
      ignoreRange = false;
      stores2.dispose();
    }
  });
});
