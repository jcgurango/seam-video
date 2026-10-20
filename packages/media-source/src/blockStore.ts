/**
 * Bounded byte-range cache for remote media files.
 *
 * mediabunny's `UrlSource` streams open-ended `Range: bytes=N-` requests and
 * resets the stream when its positional prefetch is satisfied; the server keeps
 * pumping until the reset lands, nothing is cacheable, and its LRU knows nothing
 * about the timeline. This store instead fetches fixed-size **blocks** with
 * bounded `bytes=a-b` requests (adjacent missing blocks coalesce into one
 * request), dedupes concurrent fetches of the same block, and evicts by a
 * caller-supplied **priority** (the cut planner feeds timeline distance from the
 * playhead) rather than by recency alone.
 *
 * Every read carries a **tag** (a cut id, `LIVE_TAG` for the player's own reads,
 * `INDEX_TAG` for the container index). Tags do two things: a block remembers
 * every tag that touched it (its eviction priority is the best of them), and the
 * store tracks each tag's byte **range** (`rangeOf`), which is how a cut's byte
 * span is *learned* — mediabunny doesn't expose packet byte offsets, so the
 * planner reads a cut's packets through a tagged facade and the range falls out.
 *
 * `BlockStores` is the per-host registry: one `BlockStore` per URL sharing a
 * single byte budget and priority function.
 */

export const INDEX_TAG = "index";
export const LIVE_TAG = "live";

export interface BlockStoreOptions {
  /** Block granularity (bytes). Default 1 MiB. */
  blockSize?: number;
  /** Cap on one coalesced request (bytes). Default 8 MiB. */
  maxRequestBytes?: number;
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  /** Sequential reads under one tag trigger background fetches of the next
   *  blocks (growing 2, 4, … up to `maxReadAheadBlocks`). Default on. */
  readAhead?: boolean;
  maxReadAheadBlocks?: number;
  /** Network / 5xx retries per request. Default 3. */
  retries?: number;
}

export interface BlockStoresOptions extends BlockStoreOptions {
  /** Shared cache budget across every store (bytes). Default 192 MiB. */
  budgetBytes?: number;
  /** The N most recently used blocks (across stores) are never evicted, so a
   *  reader walking a region the priority function ranks poorly can't thrash
   *  (fetch → evict → re-fetch per packet). Default 8. */
  protectRecentBlocks?: number;
}

export interface BlockStats {
  requests: number;
  bytesFetched: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface TagRange {
  first: number;
  last: number;
}

interface Block {
  index: number;
  data: Uint8Array;
  tags: Set<string>;
  lastUse: number;
}

/** Priority of a tag: larger evicts sooner. `Infinity` = evict first. */
export type PriorityFn = (tag: string) => number;

const DEFAULT_BLOCK = 1 << 20;
const DEFAULT_MAX_REQUEST = 8 << 20;
const DEFAULT_BUDGET = 192 << 20;
const DEFAULT_READ_AHEAD = 8;
const DEFAULT_RETRIES = 3;

export class BlockStores {
  private readonly stores = new Map<string, BlockStore>();
  private priority: PriorityFn = () => 0;
  private clock = 0;
  readonly budgetBytes: number;
  readonly protectRecentBlocks: number;
  usedBytes = 0;

  constructor(readonly options: BlockStoresOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET;
    this.protectRecentBlocks = options.protectRecentBlocks ?? 8;
  }

  get(url: string): BlockStore {
    let s = this.stores.get(url);
    if (!s) {
      s = new BlockStore(url, this, this.options);
      this.stores.set(url, s);
    }
    return s;
  }

  has(url: string): boolean {
    return this.stores.has(url);
  }

  /** Install the eviction priority (the planner's timeline distance). */
  setPriority(fn: PriorityFn): void {
    this.priority = fn;
  }

  /** @internal LRU clock. */
  tick(): number {
    return ++this.clock;
  }

  /** @internal Lowest priority across a block's tags; `null` = pinned. */
  priorityOf(block: Block): number | null {
    let best = Infinity;
    for (const t of block.tags) {
      if (t === INDEX_TAG) return null;
      const p = this.priority(t);
      if (p < best) best = p;
    }
    return best;
  }

  /** @internal Called by stores on insert/evict. */
  account(delta: number): void {
    this.usedBytes += delta;
    if (delta > 0 && this.usedBytes > this.budgetBytes) this.enforceBudget();
  }

  /** Evict highest-priority-number, least-recently-used blocks until the
   *  budget holds (with a little hysteresis so we don't evict per insert).
   *  The `protectRecentBlocks` most recently used blocks are exempt, so the
   *  budget is soft while the live working set alone exceeds it. */
  enforceBudget(): void {
    const target = Math.floor(this.budgetBytes * 0.9);
    if (this.usedBytes <= this.budgetBytes) return;
    const candidates: { store: BlockStore; block: Block; p: number }[] = [];
    const recent: Block[] = [];
    for (const store of this.stores.values()) {
      for (const block of store.blocksForEviction()) {
        recent.push(block);
        const p = this.priorityOf(block);
        if (p === null) continue;
        candidates.push({ store, block, p });
      }
    }
    const protectedSet = new Set<Block>();
    if (this.protectRecentBlocks > 0) {
      recent.sort((a, b) => b.lastUse - a.lastUse);
      for (let i = 0; i < Math.min(this.protectRecentBlocks, recent.length); i++) protectedSet.add(recent[i]);
    }
    candidates.sort((a, b) => b.p - a.p || a.block.lastUse - b.block.lastUse);
    for (const c of candidates) {
      if (this.usedBytes <= target) break;
      if (protectedSet.has(c.block)) continue;
      c.store.evict(c.block.index);
    }
  }

  /** Resident bytes whose priority is worse (larger) than `p` — what a new
   *  tenant at priority `p` could displace. */
  evictableBytesAbove(p: number): number {
    let n = 0;
    for (const store of this.stores.values()) {
      for (const block of store.blocksForEviction()) {
        const bp = this.priorityOf(block);
        if (bp !== null && bp > p) n += block.data.length;
      }
    }
    return n;
  }

  stats(): BlockStats {
    const out: BlockStats = { requests: 0, bytesFetched: 0, hits: 0, misses: 0, evictions: 0 };
    for (const s of this.stores.values()) {
      out.requests += s.stats.requests;
      out.bytesFetched += s.stats.bytesFetched;
      out.hits += s.stats.hits;
      out.misses += s.stats.misses;
      out.evictions += s.stats.evictions;
    }
    return out;
  }

  dispose(): void {
    for (const s of this.stores.values()) s.dispose();
    this.stores.clear();
    this.usedBytes = 0;
  }
}

export class BlockStore {
  readonly blockSize: number;
  private readonly maxRequestBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly requestInit: RequestInit;
  private readonly readAhead: boolean;
  private readonly maxReadAheadBlocks: number;
  private readonly retries: number;

  private readonly blocks = new Map<number, Block>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private readonly tagRanges = new Map<string, TagRange>();
  /** Exact block set each tag has touched: coverage + attribution use this,
   *  not the min..max range — a cut's packet reads are interleaved with lazy
   *  sample-table reads near the moov, so its range can span most of the
   *  file while its real footprint is a few contiguous blocks. */
  private readonly tagBlocks = new Map<string, Set<number>>();
  private readonly seqState = new Map<string, { next: number; run: number }>();
  private sizePromise: Promise<number> | null = null;
  private sizeKnown: number | null = null;
  private readonly abort = new AbortController();
  private disposed = false;

  readonly stats: BlockStats = { requests: 0, bytesFetched: 0, hits: 0, misses: 0, evictions: 0 };

  constructor(
    readonly url: string,
    private readonly registry: BlockStores,
    options: BlockStoreOptions = {},
  ) {
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK;
    this.maxRequestBytes = Math.max(this.blockSize, options.maxRequestBytes ?? DEFAULT_MAX_REQUEST);
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestInit = options.requestInit ?? {};
    this.readAhead = options.readAhead ?? true;
    this.maxReadAheadBlocks = options.maxReadAheadBlocks ?? DEFAULT_READ_AHEAD;
    this.retries = options.retries ?? DEFAULT_RETRIES;
  }

  /** Total file size. The first call fetches block 0 (pinned as the index). */
  size(): Promise<number> {
    if (this.sizeKnown !== null) return Promise.resolve(this.sizeKnown);
    return (this.sizePromise ??= (async () => {
      await this.fetchRun(0, 0, INDEX_TAG);
      if (this.sizeKnown === null) throw new Error(`BlockStore: no Content-Range total for ${this.url}`);
      return this.sizeKnown;
    })());
  }

  /** Bytes `[start, end)` — exact length, assembled from cached + fetched blocks. */
  async read(start: number, end: number, tag: string): Promise<Uint8Array> {
    if (this.disposed) throw new Error("BlockStore: disposed");
    if (end <= start) return new Uint8Array(0);
    const size = await this.size();
    if (end > size) throw new RangeError(`BlockStore: read [${start}, ${end}) past end of file (${size})`);
    const firstB = Math.floor(start / this.blockSize);
    const lastB = Math.floor((end - 1) / this.blockSize);
    const parts = await this.ensure(firstB, lastB, tag);
    this.noteSequential(firstB, lastB, tag);
    if (parts.length === 1) {
      const off = firstB * this.blockSize;
      return parts[0].subarray(start - off, end - off);
    }
    const out = new Uint8Array(end - start);
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      const blockStart = (firstB + i) * this.blockSize;
      const from = Math.max(start, blockStart) - blockStart;
      const to = Math.min(end, blockStart + parts[i].length) - blockStart;
      out.set(parts[i].subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }

  /** Warm `[start, end)` under `tag` without assembling (background use). */
  async prefetch(start: number, end: number, tag: string): Promise<void> {
    if (this.disposed || end <= start) return;
    const size = await this.size();
    end = Math.min(end, size);
    if (end <= start) return;
    await this.ensure(Math.floor(start / this.blockSize), Math.floor((end - 1) / this.blockSize), tag);
  }

  /** Byte range (in blocks) every read under `tag` has touched so far. */
  rangeOf(tag: string): TagRange | null {
    return this.tagRanges.get(tag) ?? null;
  }

  /** Fraction of the blocks `tag` has touched that are resident (1 when the
   *  tag is unknown). */
  coverage(tag: string): number {
    const set = this.tagBlocks.get(tag);
    if (!set || set.size === 0) return 1;
    let present = 0;
    for (const i of set) if (this.blocks.has(i)) present++;
    return present / set.size;
  }

  /** Bytes `tag` has touched (resident or not). */
  footprint(tag: string): number {
    return (this.tagBlocks.get(tag)?.size ?? 0) * this.blockSize;
  }

  get residentBytes(): number {
    let n = 0;
    for (const b of this.blocks.values()) n += b.data.length;
    return n;
  }

  /** @internal */
  blocksForEviction(): Iterable<Block> {
    return this.blocks.values();
  }

  /** @internal */
  evict(index: number): void {
    const b = this.blocks.get(index);
    if (!b) return;
    this.blocks.delete(index);
    this.stats.evictions++;
    this.registry.account(-b.data.length);
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const b of this.blocks.values()) this.registry.account(-b.data.length);
    this.blocks.clear();
    this.inflight.clear();
  }

  // ── internals ──

  /** Resolve blocks `firstB..lastB` (fetching what's missing) and tag them. */
  private async ensure(firstB: number, lastB: number, tag: string, count = true): Promise<Uint8Array[]> {
    const slots: (Promise<Uint8Array> | null)[] = new Array(lastB - firstB + 1).fill(null);
    let runStart = -1;
    const flushRun = (runEnd: number) => {
      if (runStart < 0) return;
      // Split a long run by the request cap.
      const perReq = Math.floor(this.maxRequestBytes / this.blockSize);
      for (let a = runStart; a <= runEnd; a += perReq) {
        const b = Math.min(runEnd, a + perReq - 1);
        const p = this.fetchRun(a, b, tag);
        p.catch(() => {});
        for (let i = a; i <= b; i++) {
          const pi = p.then((arr) => arr[i - a]);
          pi.catch(() => {});
          this.inflight.set(i, pi);
          pi.finally(() => {
            if (this.inflight.get(i) === pi) this.inflight.delete(i);
          }).catch(() => {});
          slots[i - firstB] = pi;
        }
      }
      runStart = -1;
    };
    for (let i = firstB; i <= lastB; i++) {
      const block = this.blocks.get(i);
      if (block) {
        if (count) this.stats.hits++;
        slots[i - firstB] = Promise.resolve(block.data);
        flushRun(i - 1);
        continue;
      }
      if (count) this.stats.misses++;
      const inflight = this.inflight.get(i);
      if (inflight) {
        slots[i - firstB] = inflight;
        flushRun(i - 1);
        continue;
      }
      if (runStart < 0) runStart = i;
    }
    flushRun(lastB);
    const parts = await Promise.all(slots as Promise<Uint8Array>[]);
    for (let i = firstB; i <= lastB; i++) {
      const b = this.blocks.get(i);
      if (b) this.touch(b, tag);
    }
    this.extendRange(tag, firstB, lastB);
    return parts;
  }

  private touch(block: Block, tag: string): void {
    block.lastUse = this.registry.tick();
    block.tags.add(tag);
    // A live read inside a cut's learned span belongs to that cut too, so the
    // span's priority (timeline distance) governs it rather than the flat
    // live priority.
    if (tag === LIVE_TAG) {
      for (const [t, set] of this.tagBlocks) {
        if (t !== INDEX_TAG && set.has(block.index)) block.tags.add(t);
      }
    }
  }

  private extendRange(tag: string, firstB: number, lastB: number): void {
    if (tag === LIVE_TAG) return; // the player's reads don't define spans
    const r = this.tagRanges.get(tag);
    if (!r) this.tagRanges.set(tag, { first: firstB, last: lastB });
    else {
      if (firstB < r.first) r.first = firstB;
      if (lastB > r.last) r.last = lastB;
    }
    let set = this.tagBlocks.get(tag);
    if (!set) this.tagBlocks.set(tag, (set = new Set()));
    for (let i = firstB; i <= lastB; i++) set.add(i);
  }

  /** Sequential-pattern detector → background read-ahead under the same tag. */
  private noteSequential(firstB: number, lastB: number, tag: string): void {
    if (!this.readAhead || tag === INDEX_TAG) return;
    const st = this.seqState.get(tag);
    const run = st && st.next === firstB ? Math.min(st.run + 1, 30) : 0;
    this.seqState.set(tag, { next: lastB + 1, run });
    if (run < 1 || this.sizeKnown === null) return;
    // A planner prefetch (cut tag) stops at the cut's out point, which the
    // store can't see — keep its overshoot to two blocks. The player's own
    // sequential streams get the full growth.
    const cap = tag === LIVE_TAG ? this.maxReadAheadBlocks : Math.min(2, this.maxReadAheadBlocks);
    const ahead = Math.min(1 << run, cap);
    const lastIndex = Math.floor((this.sizeKnown - 1) / this.blockSize);
    const from = lastB + 1;
    const to = Math.min(lastIndex, lastB + ahead);
    if (from > to) return;
    // Only kick off what's neither resident nor in flight.
    let need = false;
    for (let i = from; i <= to; i++) if (!this.blocks.has(i) && !this.inflight.has(i)) { need = true; break; }
    if (!need) return;
    this.ensure(from, to, tag, false).catch(() => {});
  }

  /** One bounded Range request for blocks `firstB..lastB`; inserts + tags them. */
  private async fetchRun(firstB: number, lastB: number, tag: string): Promise<Uint8Array[]> {
    const start = firstB * this.blockSize;
    let endInclusive = (lastB + 1) * this.blockSize - 1;
    if (this.sizeKnown !== null) endInclusive = Math.min(endInclusive, this.sizeKnown - 1);
    const headers = new Headers(this.requestInit.headers);
    headers.set("Range", `bytes=${start}-${endInclusive}`);
    let attempt = 0;
    for (;;) {
      if (this.disposed) throw new Error("BlockStore: disposed");
      try {
        this.stats.requests++;
        const res = await this.fetchFn(this.url, { ...this.requestInit, headers, signal: this.abort.signal });
        if (res.status === 206) {
          const total = parseTotal(res.headers.get("Content-Range"));
          if (total === null) throw new Error(`BlockStore: 206 without a Content-Range total from ${this.url}`);
          if (this.sizeKnown === null) this.sizeKnown = total;
          const body = new Uint8Array(await res.arrayBuffer());
          const expected = Math.min(endInclusive, total - 1) - start + 1;
          if (body.length !== expected) {
            throw new Error(`BlockStore: short range response from ${this.url}: got ${body.length}, expected ${expected}`);
          }
          this.stats.bytesFetched += body.length;
          const out: Uint8Array[] = [];
          for (let i = firstB; i <= lastB; i++) {
            const off = (i - firstB) * this.blockSize;
            if (off >= body.length) break;
            // Copy each block out of the coalesced body so evicting one block
            // frees its memory (a subarray would pin the whole response).
            const data = body.slice(off, Math.min(off + this.blockSize, body.length));
            out.push(data);
            if (!this.disposed && !this.blocks.has(i)) {
              this.blocks.set(i, { index: i, data, tags: new Set([tag]), lastUse: this.registry.tick() });
              this.registry.account(data.length);
            }
          }
          return out;
        }
        if (res.status === 200) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`BlockStore: ${this.url} ignored the Range header (200); byte-range support is required`);
        }
        if (res.status >= 500 && attempt < this.retries) {
          await res.body?.cancel().catch(() => {});
          throw new RetryableError(`HTTP ${res.status}`);
        }
        throw new Error(`BlockStore: HTTP ${res.status} ${res.statusText} fetching ${this.url}`);
      } catch (err) {
        if (this.disposed || this.abort.signal.aborted) throw err;
        const retryable = err instanceof RetryableError || isNetworkError(err);
        if (!retryable || attempt >= this.retries) throw err;
        attempt++;
        await new Promise((r) => setTimeout(r, 150 * 2 ** (attempt - 1)));
      }
    }
  }
}

class RetryableError extends Error {}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError; // fetch's network failure
}

function parseTotal(contentRange: string | null): number | null {
  const m = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  return m ? Number(m[1]) : null;
}
