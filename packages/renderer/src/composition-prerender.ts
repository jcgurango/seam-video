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
  SpatialRect,
} from "@seam/core";
import { resolveBoxProps, isKeyframed } from "@seam/core";
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
        // A nested comp with no backgroundColor must render on a
        // transparent base so it composites as a layer (not an opaque
        // black box). With one, `subTimeline.backgroundColor` wins.
        defaultBackgroundColor: "#00000000",
        // Bake the comp's own speed into its content: its children's
        // (content-time) timeline maps to the sub-`.mlt`'s (output-time)
        // duration via this speed, so a stretched comp holds/slows its
        // content across the full window instead of ending early.
        rootSpeed: child.speed,
        // Descendants already written → resolvable from here.
        compositionMlts,
      });
      limitations.push(...subLimits);

      // `inset` (crop) → wrap the content sub-`.mlt` in a cropping sub-`.mlt`
      // (same cw×ch canvas) that affine-places the content so the visible
      // sub-rect zoom-fills the canvas; the overflow is clipped by the fixed
      // canvas. Animation rides the affine `rect` keyframes — no crop filter,
      // no varying canvas. The parent then places this at the comp's
      // (windowed) display rect exactly as it would the plain content.
      const cropNode = buildCropNode(child, cw, ch, parentW, parentH, fps);
      if (cropNode) {
        const contentPath = join(dir, `comp-${seq}-src.mlt`);
        await writeFile(contentPath, xml, "utf-8");
        const cropTimeline: ResolvedTimeline = {
          duration: child.duration,
          width: cw,
          height: ch,
          contentWidth: cw,
          contentHeight: ch,
          children: [cropNode],
        };
        const { xml: cropXml, limitations: cropLimits } = buildMltDocument(
          cropTimeline,
          {
            fps,
            width: cw,
            height: ch,
            basePath: options.basePath,
            // Transparent base so it composites as a layer; the comp's speed
            // is already baked into the content sub-`.mlt`, so rootSpeed = 1.
            defaultBackgroundColor: "#00000000",
            rootSpeed: 1,
            compositionMlts: new Map([[cropNode, contentPath]]),
          },
        );
        limitations.push(...cropLimits);
        const path = join(dir, `comp-${seq++}.mlt`);
        await writeFile(path, cropXml, "utf-8");
        compositionMlts.set(child, path);
        continue;
      }

      const path = join(dir, `comp-${seq++}.mlt`);
      await writeFile(path, xml, "utf-8");
      compositionMlts.set(child, path);
    }
  }

  await walk(timeline.children, rootW, rootH);
  return { compositionMlts, limitations };
}

/** Map a visible source sub-rect (`sourceRect` fractions) to the affine rect
 *  that zoom-fills a `cw×ch` canvas with it: scale the content up by
 *  `1/(u1−u0)` and shift so the sub-rect's top-left lands at the origin. */
function cropZoomRect(
  sr: { u0: number; v0: number; u1: number; v1: number },
  cw: number,
  ch: number,
): SpatialRect {
  const du = Math.max(1e-6, sr.u1 - sr.u0);
  const dv = Math.max(1e-6, sr.v1 - sr.v0);
  const width = cw / du;
  const height = ch / dv;
  return { x: -sr.u0 * width, y: -sr.v0 * height, width, height };
}

/** Build the synthetic crop composition node placed inside the cropping
 *  sub-`.mlt`. Returns null when the comp isn't inset. Static inset bakes a
 *  single rect; animated inset bakes per-frame size/translation keyframes (the
 *  builder emits them as an affine `rect` keyframe string). */
function buildCropNode(
  comp: ResolvedComposition,
  cw: number,
  ch: number,
  parentW: number,
  parentH: number,
  fps: number,
): ResolvedComposition | null {
  const insetAnimated =
    comp.spatialInput?.inset != null && isKeyframed(comp.spatialInput.inset);
  const staticSR = comp.spatial?.sourceRect;
  if (!insetAnimated && !staticSR) return null;

  const base = {
    type: "composition" as const,
    timelineStart: 0,
    timelineEnd: comp.duration,
    duration: comp.duration,
    speed: 1,
    children: [],
    contentWidth: cw,
    contentHeight: ch,
    naturalWidth: cw,
    naturalHeight: ch,
    objectFit: "fit" as const,
  };

  if (!insetAnimated && staticSR) {
    return { ...base, spatial: cropZoomRect(staticSR, cw, ch) };
  }

  // Animated: sample the crop-zoom rect per output frame and feed it to the
  // builder as keyframed size/translation (origin top-left), so its existing
  // rect-keyframe baking animates the affine placement. `0% ± n` keeps the
  // translation absolute (a bare number would add the 50%-center default).
  const len = (v: number): string =>
    v >= 0 ? `0% + ${round(v)}` : `0% - ${round(-v)}`;
  const frameCount = Math.max(1, Math.round(comp.duration * fps));
  const sizeKf: [number, { x: number; y: number }][] = [];
  const transKf: [number, { x: string; y: string }][] = [];
  for (let f = 0; f <= frameCount; f++) {
    const t = f / fps;
    const sr =
      resolveBoxProps(
        comp.spatialInput!,
        parentW,
        parentH,
        comp.naturalWidth ?? parentW,
        comp.naturalHeight ?? parentH,
        t,
        comp.duration,
      ).sourceRect ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    const r = cropZoomRect(sr, cw, ch);
    sizeKf.push([t, { x: round(r.width), y: round(r.height) }]);
    transKf.push([t, { x: len(r.x), y: len(r.y) }]);
  }
  return {
    ...base,
    spatialInput: { origin: "0%", size: sizeKf, translation: transKf },
  };
}

function round(n: number): number {
  return Number(n.toFixed(3));
}
