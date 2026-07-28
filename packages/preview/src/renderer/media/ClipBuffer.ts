import { CanvasSink, EncodedPacketSink } from "mediabunny";
import type { WrappedCanvas } from "mediabunny";
import type { MediaStore } from "./MediaStore.js";

interface BufferedFrame {
  timestamp: number;
  canvas: HTMLCanvasElement;
}

/** Grace region outside the wanted window before we evict frames. */
const EVICT_TOLERANCE = 0.25;
/**
 * When deciding whether to restart the iterator backward (expensive), we
 * require at least this much behind-the-pivot buffer to be missing. This
 * avoids seeking the decoder on every tiny backward scrub.
 */
const BACKWARD_HYSTERESIS = 0.5;
/**
 * Maximum distance the decoder can lag behind wantedStart before we abort the
 * iterator. This is intentionally larger than one keyframe interval so the
 * normal "decoder seeks to keyframe just before wantedStart" pattern doesn't
 * look like a stale iterator; but small enough that a truly stale iterator
 * (from e.g. a big forward seek) gets cut off quickly.
 */
const DECODER_LAG_ABORT = 2.0;
/** Timestamp comparison slop (matches the renderer's clip cursor). */
const TS_EPS = 1e-4;
/** Extra frames kept at/behind the pivot in sparse mode for immediate display. */
const SPARSE_LOOKBEHIND_FRAMES = 2;

/**
 * A per-clip source-time-indexed frame cache, with two fill strategies:
 *
 * **Dense** (default): drive it by calling `setWantedRange(start, end, pivot)`
 * once per tick. It continuously fills forward from the iterator and retains
 * both lookahead and lookbehind frames for fast scrubbing.
 *
 * **Sparse** (high effective speed): drive it with `setWantedTimes(targets,
 * pivot)` — the discrete source times the display will actually sample. The
 * fill cursor is keyframe-aware (mirrors the renderer's `frameSource.ts`): a
 * forward jump to the next target re-seeks the decoder only when a keyframe
 * lies between cursor and target (`EncodedPacketSink.getKeyPacket`,
 * metadata-only); same-GOP jumps drain forward. This bounds decode cost per
 * target by GOP length and memory by the target count, instead of decoding
 * and retaining a speed-multiplied source window.
 *
 * The two modes are never mixed on one instance in practice — a clip's
 * effective speed is static, so FrameCoordinator always calls the same setter.
 * Call `getFrame(sourceTime)` to read the latest buffered frame at or before
 * the requested time (both modes).
 */
export class ClipBuffer {
  private canvasSink: CanvasSink | null = null;
  private packetSink: EncodedPacketSink | null = null;
  private frames: BufferedFrame[] = []; // sorted by timestamp
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private draining = false;
  private asyncId = 0;
  private disposed = false;
  // Authored pre-transform orientation, baked into each buffered frame on top
  // of the container rotation mediabunny already applied.
  private orientation: 0 | 90 | 180 | 270 = 0;

  private wantedStart = 0;
  private wantedEnd = 0;
  private pivot = 0;

  // ── Sparse-mode state ──
  private sparseTargets: number[] = []; // ascending source times
  /** Highest target already filled (high-water; targets ≤ this are done). */
  private sparseFilledThrough = -Infinity;
  /** Last sample the sparse cursor pulled that is ≤ the current target. */
  private sparseCurrent: WrappedCanvas | null = null;
  /** One-sample lookahead (timestamp in the future of the last target). */
  private sparsePending: WrappedCanvas | null = null;

  /** Called when new frames arrive. Useful for triggering re-render when paused. */
  onFrameAvailable: (() => void) | null = null;

  async init(
    mediaStore: MediaStore,
    sourceUrl: string,
    orientation: 0 | 90 | 180 | 270 = 0,
  ): Promise<void> {
    this.orientation = orientation;
    const videoTrack = await mediaStore.getVideoTrack(sourceUrl);
    if (!videoTrack || !(await videoTrack.canDecode())) {
      this.canvasSink = null;
      return;
    }
    // Pool of 4 is enough because we copy frames out of the pool.
    this.canvasSink = new CanvasSink(videoTrack, { poolSize: 4 });
    // Packet metadata access (no decode) for the sparse cursor's
    // seek-vs-advance decision.
    this.packetSink = new EncodedPacketSink(videoTrack);
  }

  /** Declare the source-time range of frames we want buffered. */
  setWantedRange(start: number, end: number, pivot: number): void {
    this.wantedStart = start;
    this.wantedEnd = end;
    this.pivot = pivot;
    this.evictOutOfRange();
    this.reconcile();
  }

  /** Declare the discrete source times we want buffered (sparse mode, for
   *  high-effective-speed clips). `targets` must be ascending; stability of
   *  the values across ticks (a quantized grid) is what lets the high-water
   *  mark skip already-filled targets as the window slides. */
  setWantedTimes(targets: number[], pivot: number): void {
    this.sparseTargets = targets;
    this.pivot = pivot;
    if (targets.length === 0) return;
    // Backward jump (scrub): every wanted target is behind the high-water
    // mark, so nothing would fill. Reset and let the cursor re-seek.
    if (targets[targets.length - 1] < this.sparseFilledThrough - TS_EPS) {
      this.sparseFilledThrough = -Infinity;
    }
    this.evictSparse();
    this.reconcileSparse();
  }

  /** Latest buffered frame with timestamp ≤ sourceTime. */
  getFrame(sourceTime: number): HTMLCanvasElement | null {
    let best: BufferedFrame | null = null;
    for (const f of this.frames) {
      if (f.timestamp > sourceTime) break;
      best = f;
    }
    return best?.canvas ?? null;
  }

  /** Release all cached frames and stop the iterator. */
  clear(): void {
    this.asyncId++;
    void this.iterator?.return();
    this.iterator = null;
    this.draining = false;
    this.frames = [];
    this.sparseTargets = [];
    this.sparseFilledThrough = -Infinity;
    this.sparseCurrent = null;
    this.sparsePending = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.canvasSink = null;
  }

  getBufferStatus(): { ahead: number; behind: number; frames: number } {
    if (this.frames.length === 0) {
      return { ahead: 0, behind: 0, frames: 0 };
    }
    const lastTs = this.frames[this.frames.length - 1].timestamp;
    const firstTs = this.frames[0].timestamp;
    return {
      ahead: Math.max(0, lastTs - this.pivot),
      behind: Math.max(0, this.pivot - firstTs),
      frames: this.frames.length,
    };
  }

  private evictOutOfRange(): void {
    const lo = this.wantedStart - EVICT_TOLERANCE;
    const hi = this.wantedEnd + EVICT_TOLERANCE;
    this.frames = this.frames.filter((f) => f.timestamp >= lo && f.timestamp <= hi);
  }

  private reconcile(): void {
    if (!this.canvasSink || this.disposed) return;

    // If the iterator is already running, let it make progress. The drain loop
    // stops itself once timestamps pass wantedEnd, and then a future tick will
    // re-evaluate here.
    if (this.draining) return;

    const hasFrames = this.frames.length > 0;
    const firstTs = this.frames[0]?.timestamp ?? Infinity;
    const lastTs = this.frames[this.frames.length - 1]?.timestamp ?? -Infinity;

    // Pivot coverage: if our earliest buffered frame is past the pivot, the
    // user can't see a frame at the current playhead. That outranks the
    // backward hysteresis (which exists to prevent expensive small-scrub
    // restarts, not to leave the playhead black).
    if (hasFrames && firstTs > this.pivot) {
      void this.restartIterator(this.wantedStart);
      return;
    }

    // Backward seek is expensive — only restart if we have frames but they
    // start too far past wantedStart. Empty buffers are handled by the forward
    // branch below.
    if (hasFrames && firstTs - this.wantedStart > BACKWARD_HYSTERESIS) {
      void this.restartIterator(this.wantedStart);
      return;
    }

    // Forward fill: need more frames ahead (or we have none at all).
    if (!hasFrames || this.wantedEnd > lastTs + 0.001) {
      const resumeFrom = hasFrames ? lastTs + 0.001 : this.wantedStart;
      void this.restartIterator(resumeFrom);
    }
  }

  private async restartIterator(fromTime: number): Promise<void> {
    if (!this.canvasSink || this.disposed) return;

    this.asyncId++;
    const myId = this.asyncId;

    void this.iterator?.return();
    this.iterator = this.canvasSink.canvases(fromTime);
    this.draining = true;

    try {
      while (!this.disposed && this.asyncId === myId) {
        const iter = this.iterator;
        if (!iter) break;
        const result = await iter.next();
        if (this.asyncId !== myId || this.disposed) return;

        if (!result.value) return; // iterator exhausted (end of source)

        const { canvas, timestamp } = result.value;

        // Stop if we've gone past what's wanted (with a bit of overshoot slack)
        if (timestamp > this.wantedEnd + EVICT_TOLERANCE) return;

        // Abort only if the decoder is *grossly* behind — that's the
        // large-forward-seek case where it'd take forever to plod forward
        // one frame at a time. A modest lag (typical for keyframe-seek
        // overshoot into wantedStart) should NOT abort.
        if (timestamp + DECODER_LAG_ABORT < this.wantedStart) return;

        // Decoder is slightly behind wantedStart (keyframe-decoded forward
        // from the nearest I-frame). Drop the frame but keep decoding —
        // subsequent frames will cross into the wanted region.
        if (timestamp + EVICT_TOLERANCE < this.wantedStart) continue;

        // Skip duplicates (can happen when restarting iterator near existing frames)
        if (
          this.frames.some((f) => Math.abs(f.timestamp - timestamp) < 0.001)
        ) {
          continue;
        }

        insertSorted(this.frames, {
          timestamp,
          canvas: orientCanvas(canvas, this.orientation),
        });
        this.evictOutOfRange();
        this.onFrameAvailable?.();
      }
    } finally {
      if (this.asyncId === myId) {
        this.draining = false;
      }
    }
  }

  // ── Sparse mode ──

  /** Keep only frames a current target (or the pivot lookbehind) can display;
   *  memory stays bounded by the target count, not the source span. */
  private evictSparse(): void {
    if (this.frames.length === 0) return;
    const keep = new Set<BufferedFrame>();
    for (const t of this.sparseTargets) {
      let best: BufferedFrame | null = null;
      for (const f of this.frames) {
        if (f.timestamp > t + TS_EPS) break;
        best = f;
      }
      if (best) keep.add(best);
    }
    let behind = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].timestamp <= this.pivot + TS_EPS) {
        keep.add(this.frames[i]);
        if (++behind >= SPARSE_LOOKBEHIND_FRAMES) break;
      }
    }
    if (keep.size < this.frames.length) {
      this.frames = this.frames.filter((f) => keep.has(f));
    }
  }

  /** Kick the sparse fill loop if it's idle and targets remain. */
  private reconcileSparse(): void {
    if (!this.canvasSink || this.disposed || this.draining) return;
    if (this.nextSparseTarget() === undefined) return;
    void this.fillSparse();
  }

  private nextSparseTarget(): number | undefined {
    return this.sparseTargets.find(
      (t) => t > this.sparseFilledThrough + TS_EPS,
    );
  }

  /** Single-flight fill: decode each unfilled target in order. Re-reads the
   *  target list every iteration, so a sliding window (or a backward reset)
   *  is picked up without restarting the loop. */
  private async fillSparse(): Promise<void> {
    this.draining = true;
    this.asyncId++;
    const myId = this.asyncId;
    try {
      while (!this.disposed && this.asyncId === myId) {
        const target = this.nextSparseTarget();
        if (target === undefined) return;
        const frame = await this.decodeAt(target, myId);
        if (this.asyncId !== myId || this.disposed) return;
        this.sparseFilledThrough = target;
        if (frame && !this.frames.some((f) => Math.abs(f.timestamp - frame.timestamp) < 0.001)) {
          insertSorted(this.frames, {
            timestamp: frame.timestamp,
            canvas: orientCanvas(frame.canvas, this.orientation),
          });
          this.evictSparse();
          this.onFrameAvailable?.();
        }
      }
    } finally {
      if (this.asyncId === myId) {
        this.draining = false;
      }
    }
  }

  /** Advance the sparse cursor so it holds the last sample ≤ `target`
   *  (mirrors the renderer's `decodeClip`): restart the decoder on a backward
   *  jump, or on a forward jump that crosses a keyframe — decoding from that
   *  keyframe is strictly cheaper than draining every skipped sample.
   *  Same-GOP jumps drain forward (a re-seek there would re-decode from the
   *  keyframe *behind* the cursor). Returns a pooled frame — copy before the
   *  next call pulls more than the pool size. */
  private async decodeAt(
    target: number,
    myId: number,
  ): Promise<WrappedCanvas | null> {
    const sink = this.canvasSink;
    if (!sink) return null;
    // Decoder position = furthest sample pulled so far.
    const pos =
      this.sparsePending?.timestamp ??
      this.sparseCurrent?.timestamp ??
      -Infinity;

    let restart = this.iterator === null || target < pos - TS_EPS;
    if (!restart && this.packetSink && target > pos + TS_EPS) {
      const key = await this.packetSink.getKeyPacket(target, {
        metadataOnly: true,
      });
      if (this.asyncId !== myId || this.disposed) return null;
      restart = key !== null && key.timestamp > pos + TS_EPS;
    }
    if (restart) {
      void this.iterator?.return();
      this.iterator = sink.canvases(Math.max(0, target));
      this.sparseCurrent = null;
      this.sparsePending = null;
    }

    for (;;) {
      if (this.sparsePending) {
        if (this.sparsePending.timestamp <= target + TS_EPS) {
          this.sparseCurrent = this.sparsePending;
          this.sparsePending = null;
          continue;
        }
        break; // lookahead is in the future — current is correct
      }
      const iter = this.iterator;
      if (!iter) return null;
      const result = await iter.next();
      if (this.asyncId !== myId || this.disposed) return null;
      if (!result.value) break; // end of source
      if (result.value.timestamp <= target + TS_EPS) {
        this.sparseCurrent = result.value;
      } else {
        this.sparsePending = result.value;
        break;
      }
    }
    return this.sparseCurrent;
  }
}

function copyCanvas(src: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement {
  const dst = document.createElement("canvas");
  dst.width = src.width;
  dst.height = src.height;
  const ctx = dst.getContext("2d");
  if (ctx) ctx.drawImage(src as CanvasImageSource, 0, 0);
  return dst;
}

/** Copy a frame into a fresh canvas, baking a clockwise 0/90/180/270 rotation
 *  (90/270 swap dims). Matches the renderer's `rotateRGBA` convention so the
 *  preview and headless renderer orient identically. */
function orientCanvas(
  src: HTMLCanvasElement | OffscreenCanvas,
  orientation: 0 | 90 | 180 | 270,
): HTMLCanvasElement {
  if (orientation === 0) return copyCanvas(src);
  const swap = orientation === 90 || orientation === 270;
  const dst = document.createElement("canvas");
  dst.width = swap ? src.height : src.width;
  dst.height = swap ? src.width : src.height;
  const ctx = dst.getContext("2d");
  if (!ctx) return copyCanvas(src);
  ctx.translate(dst.width / 2, dst.height / 2);
  ctx.rotate((orientation * Math.PI) / 180);
  ctx.drawImage(src as CanvasImageSource, -src.width / 2, -src.height / 2);
  return dst;
}

function insertSorted(arr: BufferedFrame[], f: BufferedFrame): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp < f.timestamp) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, f);
}
