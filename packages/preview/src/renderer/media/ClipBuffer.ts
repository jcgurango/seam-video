import { CanvasSink } from "mediabunny";
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

/**
 * A per-clip source-time-indexed frame cache.
 *
 * Drive it by calling `setWantedRange(start, end, pivot)` once per tick.
 * It continuously fills forward from the iterator and retains both lookahead
 * and lookbehind frames for fast scrubbing. Call `getFrame(sourceTime)` to
 * read the latest buffered frame at or before the requested time.
 */
export class ClipBuffer {
  private canvasSink: CanvasSink | null = null;
  private frames: BufferedFrame[] = []; // sorted by timestamp
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private draining = false;
  private asyncId = 0;
  private disposed = false;

  private wantedStart = 0;
  private wantedEnd = 0;
  private pivot = 0;

  /** Called when new frames arrive. Useful for triggering re-render when paused. */
  onFrameAvailable: (() => void) | null = null;

  async init(mediaStore: MediaStore, sourceUrl: string): Promise<void> {
    const videoTrack = await mediaStore.getVideoTrack(sourceUrl);
    if (!videoTrack || !(await videoTrack.canDecode())) {
      this.canvasSink = null;
      return;
    }
    // Pool of 4 is enough because we copy frames out of the pool.
    this.canvasSink = new CanvasSink(videoTrack, { poolSize: 4 });
  }

  /** Declare the source-time range of frames we want buffered. */
  setWantedRange(start: number, end: number, pivot: number): void {
    this.wantedStart = start;
    this.wantedEnd = end;
    this.pivot = pivot;
    this.evictOutOfRange();
    this.reconcile();
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

        insertSorted(this.frames, { timestamp, canvas: copyCanvas(canvas) });
        this.evictOutOfRange();
        this.onFrameAvailable?.();
      }
    } finally {
      if (this.asyncId === myId) {
        this.draining = false;
      }
    }
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
