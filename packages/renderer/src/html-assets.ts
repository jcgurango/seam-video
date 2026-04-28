import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { htmlToSvg } from "@seam/html-renderer";
import { loadDefaultFonts } from "@seam/html-renderer/node-fonts";
import type { ResolvedChild, ResolvedHtml, ResolvedTimeline } from "@seam/core";

export interface HtmlAssets {
  /** Map from each html node in the timeline to its pre-rasterized PNG path. */
  byNode: Map<ResolvedHtml, string>;
  /** Directory the PNGs were written into, for cleanup. */
  dir: string;
}

/**
 * Walks the timeline, renders every html node's source to an SVG via
 * satori, then to a PNG via resvg, and writes each to `dir`. Returns the
 * mapping that buildFfmpegCommand needs as `htmlAssets`. If the timeline
 * has no html nodes, the directory isn't created.
 */
export async function prerenderHtmlAssets(
  timeline: ResolvedTimeline,
  dir: string
): Promise<HtmlAssets> {
  const nodes = collectHtmlNodes(timeline.children);
  if (nodes.length === 0) {
    return { byNode: new Map(), dir };
  }
  await mkdir(dir, { recursive: true });
  const fonts = await loadDefaultFonts();

  const byNode = new Map<ResolvedHtml, string>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const svg = await htmlToSvg(
      node.source,
      node.contentWidth,
      node.contentHeight,
      { fonts }
    );
    const resvg = new Resvg(svg, {
      background: "rgba(0,0,0,0)",
      fitTo: { mode: "width", value: node.contentWidth },
    });
    const png = resvg.render().asPng();
    const path = join(dir, `html-${i}.png`);
    await writeFile(path, png);
    byNode.set(node, path);
  }
  return { byNode, dir };
}

/** Best-effort `rm -rf` of the assets dir. Ignores missing-dir errors. */
export async function cleanupHtmlAssets(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Nothing to clean up — fine.
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
