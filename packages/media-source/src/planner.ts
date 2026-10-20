/**
 * Cut planner — drives prefetch and eviction of the block stores from the
 * timeline instead of from byte positions.
 *
 * Given the cuts (`cutsFromTimeline` / the preview's flat clips) and a playhead
 * feed, it (1) installs a priority on the registry = each cut's **timeline
 * distance** from the playhead (0 inside the cut; the player's own untagged
 * reads sit at `liveDistance`; the container index is pinned), so the cache
 * sheds the cuts that are farthest away first; and (2) warms the cuts inside
 * `horizon` seconds ahead, nearest first, by reading their packets — from the
 * keyframe at or before `sourceIn` to `sourceOut`, video and audio — through a
 * per-source prefetch `Input` whose `PlannedSource` tag is set to the cut id.
 * The bytes mediabunny asks for while doing that *are* the cut's span, which the
 * store records per tag; a cut whose span was evicted gets re-warmed when it
 * comes back into the horizon.
 *
 * One prefetch per source at a time (tags stay unambiguous), `maxConcurrent`
 * across sources. A prefetch abandons itself when the playhead jumps far away.
 */
import { ALL_FORMATS, EncodedPacketSink, Input, type InputTrack } from "mediabunny";
import { BlockStores, INDEX_TAG, LIVE_TAG } from "./blockStore.js";
import { PlannedSource } from "./plannedSource.js";
import type { Cut } from "./cuts.js";

export interface CutPlannerOptions {
  stores: BlockStores;
  /** Seconds of timeline ahead of the playhead to keep warm. Default 20. */
  horizon?: number;
  /** Priority (timeline-distance equivalent) of the player's own reads that
   *  fall outside any learned span. Default 10. */
  liveDistance?: number;
  /** Prefetches in flight across sources. Default 2. */
  maxConcurrent?: number;
  /** Which sources the planner handles. Default: `http(s)://` URLs. */
  isRemote?: (source: string) => boolean;
  /** Surfaced prefetch failures (default: console.warn once per cut). */
  onError?: (cut: Cut, err: unknown) => void;
}

type Status = "pending" | "running" | "done" | "failed";

/** Playhead motion (s) required before a done-but-evicted cut re-warms. */
const REWARM_STEP = 0.5;

interface SourceEntry {
  input: Input;
  source: PlannedSource;
  tracks: Promise<{ video: InputTrack | null; audio: InputTrack | null }>;
  busy: boolean;
}

export class CutPlanner {
  private readonly stores: BlockStores;
  private readonly horizon: number;
  private readonly liveDistance: number;
  private readonly maxConcurrent: number;
  private readonly isRemote: (source: string) => boolean;
  private readonly onError: (cut: Cut, err: unknown) => void;

  private cuts: Cut[] = [];
  private readonly byId = new Map<string, Cut>();
  private readonly status = new Map<string, Status>();
  /** Playhead at which each cut last finished warming — a done cut that lost
   *  blocks is re-warmed only once the playhead has moved, never in a loop. */
  private readonly warmedAt = new Map<string, number>();
  private scheduled = false;
  private readonly entries = new Map<string, SourceEntry>();
  private playhead = 0;
  private running = 0;
  private disposed = false;

  constructor(options: CutPlannerOptions) {
    this.stores = options.stores;
    this.horizon = options.horizon ?? 20;
    this.liveDistance = options.liveDistance ?? 10;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.isRemote = options.isRemote ?? ((s) => /^https?:\/\//i.test(s));
    this.onError = options.onError ?? ((cut, err) => console.warn(`CutPlanner: prefetch of cut ${cut.id} failed`, err));
    this.stores.setPriority((tag) => this.distanceOf(tag));
  }

  /** Replace the cut list (e.g. on every timeline edit). Running prefetches
   *  finish or abandon on their own; statuses restart from scratch. */
  setCuts(cuts: Cut[]): void {
    this.cuts = cuts.filter((c) => this.isRemote(c.source));
    this.byId.clear();
    this.status.clear();
    this.warmedAt.clear();
    for (const c of this.cuts) this.byId.set(c.id, c);
    this.schedule();
  }

  get cutCount(): number {
    return this.cuts.length;
  }

  /** Feed the playhead (every tick is fine; the work is O(cuts)). */
  update(playhead: number): void {
    this.playhead = playhead;
    this.schedule();
  }

  /** Timeline distance (s) of a tag's cut from the playhead. A cut being
   *  warmed right now counts as 0: evicting beneath a running prefetch would
   *  make it re-fetch the same block per packet. */
  distanceOf(tag: string): number {
    if (tag === INDEX_TAG) return -Infinity;
    const cut = this.byId.get(tag);
    if (!cut) return this.liveDistance; // LIVE_TAG and unknown tags
    if (this.status.get(tag) === "running") return 0;
    return this.rawDistance(cut);
  }

  private rawDistance(cut: Cut): number {
    if (this.playhead >= cut.start && this.playhead < cut.end) return 0;
    return cut.start > this.playhead ? cut.start - this.playhead : this.playhead - cut.end;
  }

  /** Could `cut` be warmed without displacing content ranked nearer? Uses the
   *  cut's learned span when it has one, else the mean of the known spans. */
  private fits(cut: Cut, d: number): boolean {
    const store = this.stores.get(cut.source);
    let estimate = store.footprint(cut.id);
    if (estimate === 0) {
      let total = 0;
      let n = 0;
      for (const c of this.cuts) {
        const f = this.stores.get(c.source).footprint(c.id);
        if (f > 0) {
          total += f;
          n++;
        }
      }
      estimate = n > 0 ? total / n : 2 * store.blockSize;
    }
    const free = this.stores.budgetBytes - this.stores.usedBytes;
    return free + this.stores.evictableBytesAbove(d) >= estimate;
  }

  statusOf(cutId: string): Status {
    return this.status.get(cutId) ?? "pending";
  }

  /** Resolves once nothing is in flight (tests / renderer shutdown). */
  async idle(): Promise<void> {
    while (this.running > 0) await new Promise((r) => setTimeout(r, 10));
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.input.dispose();
    this.entries.clear();
  }

  // ── internals ──

  private schedule(): void {
    if (this.disposed) return;
    const candidates: { cut: Cut; d: number }[] = [];
    for (const cut of this.cuts) {
      const st = this.statusOf(cut.id);
      if (st === "running" || st === "failed") continue;
      const d = this.rawDistance(cut);
      // Ahead of (or under) the playhead only: behind is history.
      if (d > this.horizon || cut.end <= this.playhead) continue;
      if (st === "done") {
        if (this.stores.get(cut.source).coverage(cut.id) >= 1) continue;
        const at = this.warmedAt.get(cut.id);
        if (at !== undefined && Math.abs(this.playhead - at) < REWARM_STEP) continue;
      }
      candidates.push({ cut, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const { cut, d } of candidates) {
      if (this.running >= this.maxConcurrent) break;
      const entry = this.entry(cut.source);
      if (entry.busy) continue;
      if (!this.fits(cut, d)) continue;
      void this.prefetch(cut, entry);
    }
  }

  private entry(source: string): SourceEntry {
    let e = this.entries.get(source);
    if (!e) {
      // The index (moov) is read while the tag is INDEX_TAG → pinned.
      const planned = new PlannedSource(this.stores.get(source), INDEX_TAG);
      const input = new Input({ source: planned, formats: ALL_FORMATS });
      const tracks = (async () => {
        const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
        planned.tag = LIVE_TAG;
        return { video, audio };
      })();
      tracks.catch(() => {});
      e = { input, source: planned, tracks, busy: false };
      this.entries.set(source, e);
    }
    return e;
  }

  private abandoned(cut: Cut): boolean {
    return this.disposed || !this.byId.has(cut.id) || this.distanceOf(cut.id) > this.horizon * 1.5;
  }

  private async prefetch(cut: Cut, entry: SourceEntry): Promise<void> {
    entry.busy = true;
    this.running++;
    this.status.set(cut.id, "running");
    let finished = false;
    let failed = false;
    try {
      const { video, audio } = await entry.tracks;
      entry.source.tag = cut.id;
      const tracks = cut.kind === "audio" ? [audio] : [video, audio];
      for (const track of tracks) {
        if (!track || this.abandoned(cut)) continue;
        const sink = new EncodedPacketSink(track);
        // Full packets (not metadata-only): `packets()` needs a start packet
        // with data, and the bytes are what we're here to warm anyway.
        const first =
          track === video ? await sink.getKeyPacket(cut.sourceIn) : await sink.getPacket(cut.sourceIn);
        const startPacket = first ?? (await sink.getFirstPacket());
        if (!startPacket) continue;
        for await (const packet of sink.packets(startPacket)) {
          if (packet.timestamp >= cut.sourceOut || this.abandoned(cut)) break;
        }
      }
      finished = !this.abandoned(cut);
    } catch (err) {
      failed = true;
      if (!this.disposed) this.onError(cut, err);
    } finally {
      entry.source.tag = LIVE_TAG;
      entry.busy = false;
      this.running--;
      // A failed cut stays failed until the next setCuts — retrying on every
      // tick would spin; the live decoder still reads it on demand.
      if (!this.disposed && this.byId.has(cut.id)) {
        this.status.set(cut.id, failed ? "failed" : finished ? "done" : "pending");
        this.warmedAt.set(cut.id, this.playhead);
      }
    }
    this.scheduleLater();
  }

  /** Schedule on a macrotask: a chain of cache-hit prefetches must never
   *  starve the host's event loop (frame loop, timers, I/O). */
  private scheduleLater(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.schedule();
    }, 0);
  }
}
