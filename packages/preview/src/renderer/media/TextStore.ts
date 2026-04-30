import type {
  ResolvedChild,
  ResolvedText,
  ResolvedTimeline,
} from "@seam/core";
import { textToSvg, textHasAnimatedStyle } from "../text/textSvg.js";

interface AnimatedEntry {
  node: ResolvedText;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** Last node-local time we rasterized at, in seconds. Skips re-decode
   *  when the time hasn't advanced enough to change anything. */
  lastT: number;
  /** Async generation token — bumped on each rasterize-call so a stale
   *  decode that finishes after a newer call doesn't clobber the canvas. */
  gen: number;
}

/**
 * Manages per-text-node OffscreenCanvases. Static text is rasterized once
 * at setTimeline. Animated text (any keyframed style field, including
 * inside runs) is re-rasterized on each `update(currentTime)` call so
 * keyframes propagate to the GPU's texture upload path.
 *
 * Each canvas's identity is stable across frames so the TextureManager
 * only allocates one GPU texture per node.
 */
export class TextStore {
  private bitmaps = new Map<ResolvedText, OffscreenCanvas>();
  private animated = new Map<ResolvedText, AnimatedEntry>();
  /** Fires when a text node's bitmap has finished decoding so the
   *  outer render loop can repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(timeline: ResolvedTimeline): Promise<void> {
    this.dispose();
    const nodes = collectTextNodes(timeline.children);
    if (nodes.length === 0) return;
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const canvas = new OffscreenCanvas(
            Math.max(1, Math.round(node.contentWidth)),
            Math.max(1, Math.round(node.contentHeight))
          );
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
          // Register the canvas before the async decode so the GPU
          // pipeline's getFrame returns the (initially blank) canvas
          // instead of null while the decode is in flight.
          this.bitmaps.set(node, canvas);

          if (textHasAnimatedStyle(node)) {
            // Animated: track for per-frame rasterization. The first
            // raster runs at t=0 to seed the canvas before playback.
            const entry: AnimatedEntry = { node, canvas, ctx, lastT: -1, gen: 0 };
            this.animated.set(node, entry);
            await this.rasterizeAnimated(entry, 0);
          } else {
            await rasterizeOnce(node, canvas, ctx, 0);
            this.onFrameAvailable?.();
          }
        } catch (err) {
          console.error("Text node rasterization failed:", err);
        }
      })
    );
  }

  /** Per-frame hook: re-rasterize any animated text whose node-local time
   *  has advanced. `currentTime` is in the *root* timeline's coordinate
   *  space; the call is cheap-skipped when no text is animated. */
  update(currentTime: number): void {
    if (this.animated.size === 0) return;
    for (const entry of this.animated.values()) {
      const t = currentTime - entry.node.timelineStart;
      // Only re-rasterize when active in the timeline. Outside the active
      // window, holding the most recent frame is fine — it's not visible.
      const duration = entry.node.timelineEnd - entry.node.timelineStart;
      if (t < 0 || t > duration) continue;
      // Cheap dedupe: ~1ms quantization saves redraws when the clock
      // hasn't moved (e.g. paused, redraws on hover). Adjust if too coarse.
      if (Math.abs(t - entry.lastT) < 0.001) continue;
      entry.lastT = t;
      void this.rasterizeAnimated(entry, t);
    }
  }

  private async rasterizeAnimated(entry: AnimatedEntry, t: number): Promise<void> {
    const myGen = ++entry.gen;
    try {
      const svg = textToSvg(entry.node, t);
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (entry.gen !== myGen) return; // a newer rasterize already started
        entry.ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
        entry.ctx.drawImage(img, 0, 0, entry.canvas.width, entry.canvas.height);
        this.onFrameAvailable?.();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Animated text rasterization failed:", err);
    }
  }

  getFrame(node: ResolvedText): OffscreenCanvas | null {
    return this.bitmaps.get(node) ?? null;
  }

  dispose(): void {
    this.bitmaps.clear();
    this.animated.clear();
  }
}

async function rasterizeOnce(
  node: ResolvedText,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  t: number,
): Promise<void> {
  const svg = textToSvg(node, t);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function collectTextNodes(children: ResolvedChild[]): ResolvedText[] {
  const out: ResolvedText[] = [];
  walk(children);
  return out;

  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "text") out.push(c);
      else if (c.type === "composition") walk(c.children);
    }
  }
}
