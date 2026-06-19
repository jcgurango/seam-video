import type {
  ResolvedChild,
  ResolvedText,
  ResolvedTimeline,
} from "@seam/core";
import {
  layoutText,
  textHasAnimatedStyle,
  drawTextLayout,
} from "@seam/core";

interface AnimatedEntry {
  node: ResolvedText;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** Last node-local time we rasterized at, in seconds. Skips the redraw
   *  when the time hasn't advanced enough to change anything. */
  lastT: number;
}

/**
 * Manages per-text-node OffscreenCanvases. Static text rasterizes once
 * at setTimeline. Animated text (any keyframed style field, including
 * inside runs) re-rasterizes on each `update(currentTime)` call so the
 * GPU's texture upload picks up the new pixels.
 *
 * Drawing goes straight through Pretext-laid-out text into the
 * OffscreenCanvas via `drawTextLayout` — no SVG round-trip, no async
 * `<img>` decode. Same engine measures + renders, no glyph-position drift.
 *
 * Each canvas's identity is stable across frames so the TextureManager
 * only allocates one GPU texture per node.
 */
/** Baked (t=0) inner-canvas size for a resolved text node. The spatial pass
 *  stores it in `intrinsicWidth`; falls back to a static-number contentWidth
 *  for hand-built nodes. */
function bakedSize(node: ResolvedText): { w: number; h: number } {
  const w = node.intrinsicWidth ?? (typeof node.contentWidth === "number" ? node.contentWidth : 0);
  const h = node.intrinsicHeight ?? (typeof node.contentHeight === "number" ? node.contentHeight : 0);
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

export class TextStore {
  private bitmaps = new Map<ResolvedText, OffscreenCanvas>();
  private animated = new Map<ResolvedText, AnimatedEntry>();
  /** Live inner-canvas size per node, sampled per-frame by the compositor and
   *  pushed in via {@link setContentSizes}. Absent → the baked size. */
  private sizes = new Map<ResolvedText, { w: number; h: number }>();
  /** Fires when a text node's bitmap has been (re-)drawn so the outer
   *  render loop can repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  private sizeFor(node: ResolvedText): { w: number; h: number } {
    return this.sizes.get(node) ?? bakedSize(node);
  }

  setTimeline(timeline: ResolvedTimeline): void {
    this.dispose();
    const nodes = collectTextNodes(timeline.children);
    if (nodes.length === 0) return;
    for (const node of nodes) {
      try {
        const { w, h } = this.sizeFor(node);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
        this.bitmaps.set(node, canvas);

        if (textHasAnimatedStyle(node)) {
          // Animated: track for per-frame redraw. Seed the canvas at
          // t=0 so the first paint shows something before playback.
          this.animated.set(node, { node, canvas, ctx, lastT: -1 });
        }
        drawTextLayout(ctx, layoutText(node, 0, w, h));
      } catch (err) {
        console.error("Text node rasterization failed:", err);
      }
    }
    this.onFrameAvailable?.();
  }

  /** Push the compositor's per-frame inner-canvas sizes (from the render list).
   *  When a node's size changes, resize its bitmap + redraw immediately so the
   *  texture is correct for the frame about to composite (text reflows). */
  setContentSizes(
    sizes: Map<ResolvedText, { w: number; h: number }>,
    currentTime: number,
  ): void {
    let anyRedrew = false;
    for (const [node, size] of sizes) {
      const w = Math.max(1, Math.round(size.w));
      const h = Math.max(1, Math.round(size.h));
      const prev = this.sizes.get(node);
      this.sizes.set(node, { w, h });
      const canvas = this.bitmaps.get(node);
      if (!canvas) continue;
      if (prev && prev.w === w && prev.h === h) continue; // unchanged
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const t = Math.max(0, currentTime - node.timelineStart);
      try {
        canvas.width = w; // resizing clears the canvas
        canvas.height = h;
        drawTextLayout(ctx, layoutText(node, t, w, h));
        const anim = this.animated.get(node);
        if (anim) anim.lastT = t;
        anyRedrew = true;
      } catch (err) {
        console.error("Animated text resize failed:", err);
      }
    }
    if (anyRedrew) this.onFrameAvailable?.();
  }

  /** Per-frame hook: redraw any animated text whose node-local time has
   *  advanced. `currentTime` is in the *root* timeline's coordinate
   *  space; the call is cheap-skipped when no text is animated. */
  update(currentTime: number): void {
    if (this.animated.size === 0) return;
    let anyRedrew = false;
    for (const entry of this.animated.values()) {
      const t = currentTime - entry.node.timelineStart;
      // Outside the active window holding the most recent frame is
      // fine — the node won't be drawn anyway.
      const duration = entry.node.timelineEnd - entry.node.timelineStart;
      if (t < 0 || t > duration) continue;
      // Cheap dedupe at ~1ms to skip redraws when the clock hasn't moved.
      if (Math.abs(t - entry.lastT) < 0.001) continue;
      entry.lastT = t;
      try {
        const { w, h } = this.sizeFor(entry.node);
        drawTextLayout(entry.ctx, layoutText(entry.node, t, w, h));
        anyRedrew = true;
      } catch (err) {
        console.error("Animated text rasterization failed:", err);
      }
    }
    if (anyRedrew) this.onFrameAvailable?.();
  }

  getFrame(node: ResolvedText): OffscreenCanvas | null {
    return this.bitmaps.get(node) ?? null;
  }

  dispose(): void {
    this.bitmaps.clear();
    this.animated.clear();
    this.sizes.clear();
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
