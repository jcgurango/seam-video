import type { ResolvedChild, ResolvedHtml, ResolvedTimeline } from "@seam/core";
import { htmlToSvg } from "@seam/html-renderer";
import { loadDefaultFonts } from "@seam/html-renderer/browser-fonts";

/**
 * Pre-rasterizes every html node in a timeline into an OffscreenCanvas
 * (via satori → SVG → Image → 2D draw) so the GPU compositor can treat
 * them like clip frames. Re-runs on every setTimeline so source edits
 * propagate.
 */
export class HtmlStore {
  private bitmaps = new Map<ResolvedHtml, OffscreenCanvas>();

  async setTimeline(timeline: ResolvedTimeline): Promise<void> {
    this.dispose();
    const nodes = collectHtmlNodes(timeline.children);
    if (nodes.length === 0) return;
    const fonts = await loadDefaultFonts();
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const n = Date.now();
          const svg = await htmlToSvg(
            node.source,
            node.contentWidth,
            node.contentHeight,
            { fonts }
          );
          console.log('Parsing took ' + (Date.now() - n));
          const r = Date.now();

          const canvas = await svgToCanvas(
            svg,
            node.contentWidth,
            node.contentHeight
          );

          console.log('Rendering took ' + (Date.now() - r));
          console.log('Total took ' + (Date.now() - n));
          this.bitmaps.set(node, canvas);
        } catch (err) {
          console.error("HTML node rasterization failed:", err);
        }
      })
    );
  }

  getFrame(node: ResolvedHtml): OffscreenCanvas | null {
    return this.bitmaps.get(node) ?? null;
  }

  dispose(): void {
    this.bitmaps.clear();
  }
}

async function svgToCanvas(
  svg: string,
  w: number,
  h: number
): Promise<OffscreenCanvas> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to decode SVG"));
      img.src = url;
    });
    const canvas = new OffscreenCanvas(Math.round(w), Math.round(h));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context for HTML rasterizer");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function collectHtmlNodes(children: ResolvedChild[]): ResolvedHtml[] {
  const out: ResolvedHtml[] = [];
  walk(children);
  return out;

  function walk(arr: ResolvedChild[]) {
    for (const c of arr) {
      if (c.type === "html") out.push(c);
      else if (c.type === "composition") walk(c.children);
    }
  }
}
