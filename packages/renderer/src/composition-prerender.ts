// Pre-render each *complex* nested composition (one with its own spatial /
// non-fit objectFit / filters — see `isComplexComposition`) to a standalone
// sub-`.mlt` file, returning a map from the ResolvedComposition identity to
// its file path.
//
// Why a separate file per composition: melt can reference an external `.mlt`
// as a producer (`<producer resource="comp-0.mlt"/>`) and renders it at the
// sub-document's *own* profile — which we set to the composition's content
// box. The parent then qtblend-places that frame at the composition's
// display rect with its wrapper filters, so the whole composition composites
// as a single layer (correct group opacity / filter isolation, and content
// rendered at its native resolution — no profile-stretch). This mirrors the
// `rasterizeAllText` / `rasterizeAllGraphics` sidecar pattern: build assets
// up front, hand the builder a node-keyed map.
//
// Audio is intentionally omitted from the sub-`.mlt`s — the ffmpeg audio
// pass already walks into compositions and mixes the whole timeline, so the
// nested video producers stay silent (`audio_index=-1` on the producer).

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ResolvedChild,
  ResolvedComposition,
  ResolvedTimeline,
} from "@seam/core";
import {
  buildMltDocument,
  isComplexComposition,
  type MltLimitation,
} from "./mlt-builder.js";
import type { TextRasterMap } from "./text/textRaster.js";
import type { GraphicRasterMap } from "./graphic/raster.js";
import type { IntrinsicSizeMap } from "./media-probe.js";

export interface CompositionPrerenderOptions {
  basePath?: string;
  textRasters?: TextRasterMap;
  graphicRasters?: GraphicRasterMap;
  intrinsicSizes?: IntrinsicSizeMap;
}

export interface CompositionPrerenderResult {
  /** ResolvedComposition identity → absolute sub-`.mlt` path. Pass to
   *  `buildMltDocument` as `compositionMlts`. */
  compositionMlts: Map<ResolvedComposition, string>;
  /** Translation limitations surfaced while building the sub-documents. */
  limitations: MltLimitation[];
}

/** Walk the resolved tree depth-first, writing a sub-`.mlt` for every
 *  complex composition. Descendants are written first so that a parent
 *  composition's sub-document can already reference its complex children's
 *  files (the map is threaded through the recursive `buildMltDocument`). */
export async function prerenderCompositionMlts(
  timeline: ResolvedTimeline,
  dir: string,
  fps: number,
  options: CompositionPrerenderOptions = {},
): Promise<CompositionPrerenderResult> {
  const compositionMlts = new Map<ResolvedComposition, string>();
  const limitations: MltLimitation[] = [];
  let seq = 0;

  const rootW = timeline.width ?? (timeline.contentWidth as number | undefined) ?? 1080;
  const rootH = timeline.height ?? (timeline.contentHeight as number | undefined) ?? 1920;

  async function walk(children: ResolvedChild[], parentW: number, parentH: number): Promise<void> {
    for (const child of children) {
      if (child.type !== "composition") continue;
      // The composition's content box is its resolved contentWidth/Height
      // (always a pixel number post-resolve); fall back to the parent box.
      const cw = (child.contentWidth as number | undefined) ?? parentW;
      const ch = (child.contentHeight as number | undefined) ?? parentH;
      // Descendants first so this comp's sub-doc can reference theirs.
      await walk(child.children, cw, ch);

      if (!isComplexComposition(child)) continue;

      const subTimeline: ResolvedTimeline = {
        duration: child.duration,
        width: cw,
        height: ch,
        contentWidth: cw,
        contentHeight: ch,
        backgroundColor: child.backgroundColor,
        children: child.children,
      };
      const { xml, limitations: subLimits } = buildMltDocument(subTimeline, {
        fps,
        width: cw,
        height: ch,
        basePath: options.basePath,
        textRasters: options.textRasters,
        graphicRasters: options.graphicRasters,
        intrinsicSizes: options.intrinsicSizes,
        // Descendants already written → resolvable from here.
        compositionMlts,
      });
      limitations.push(...subLimits);
      const path = join(dir, `comp-${seq++}.mlt`);
      await writeFile(path, xml, "utf-8");
      compositionMlts.set(child, path);
    }
  }

  await walk(timeline.children, rootW, rootH);
  return { compositionMlts, limitations };
}
