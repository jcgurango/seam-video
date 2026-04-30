import type {
  ResolvedChild,
  ResolvedText,
  ResolvedTimeline,
} from "@seam/core";
import { textToSvg } from "../text/textSvg.js";

/**
 * Pre-rasterizes every text node in a timeline to an OffscreenCanvas
 * (via Pretext-laid-out SVG → <img> → 2D draw) so the GPU compositor
 * can treat them like clip frames. Re-runs on every setTimeline so doc
 * edits propagate. Each canvas's identity is stable across frames so
 * the TextureManager only allocates one GPU texture per node.
 */
export class TextStore {
  private bitmaps = new Map<ResolvedText, OffscreenCanvas>();
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
          const svg = textToSvg(node);
          const blob = new Blob([svg], { type: "image/svg+xml" });
          const url = URL.createObjectURL(blob);
          try {
            const img = new Image();
            img.src = url;
            await img.decode();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            this.onFrameAvailable?.();
          } finally {
            URL.revokeObjectURL(url);
          }
        } catch (err) {
          console.error("Text node rasterization failed:", err);
        }
      })
    );
  }

  getFrame(node: ResolvedText): OffscreenCanvas | null {
    return this.bitmaps.get(node) ?? null;
  }

  dispose(): void {
    this.bitmaps.clear();
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
