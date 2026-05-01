// Build an MLT XML document from a resolved seam timeline.
//
// Architecture:
//   - One <producer> per unique media file (videos, audio).
//   - One <producer> per text PNG (qimage service, ttl=1).
//   - Track 0 (video): a single <playlist> of every clip in timeline
//     order; sequential clips back-to-back, blanks for any gaps.
//   - Tracks 1..N (text overlays): one track per text node. Each track
//     gets exactly one <composite> transition whose `in`/`out` clamp
//     it to the text's own time range and whose `geometry` frames are
//     relative to that `in`. Sharing a track between non-overlapping
//     texts (the previous packed model) caused MLT to interpolate
//     between adjacent texts' keyframes — visually a static text
//     would drift across the canvas toward its neighbour's rect.
//   - Tracks N+1..M (audio): greedy-packed so non-overlapping audio
//     entries share a playlist; summed into the master via
//     <mix combine="1"> transitions. Audio doesn't have a position to
//     interpolate so the packing concern doesn't apply there.
//
// Animation:
//   - Animated text spatial: re-resolve `spatialInput` per output frame
//     and emit one MLT geometry keyframe per frame the value changes
//     (RLE-collapsed). Static spatial → a single keyframe at the entry's
//     start frame, MLT holds it.
//   - Opacity filter: folded into the same geometry's alpha channel,
//     sampled per frame the same way.
//   - All other filters (adjust / colorbalance / colortemperature) and
//     animated `volume` aren't translated yet — see `MltLimitations`.

import { resolve } from "node:path";
import {
  hasAnimatedSpatialInput,
  isKeyframed,
  resolveBoxProps,
  sampleNumber,
} from "@seam/core";
import type {
  Filter,
  Keyframed,
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedText,
  ResolvedTimeline,
  SpatialAnchor,
  SpatialInput,
  SpatialRect,
} from "@seam/core";
import type { TextRasterMap } from "./text/textRaster.js";

export interface MltOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** Base directory for resolving relative `source` paths. */
  basePath?: string;
  /** PNGs from `rasterizeAllText`, keyed by ResolvedText identity. */
  textRasters?: TextRasterMap;
}

/** Field that this builder doesn't yet translate. Surfaced so the
 *  caller can warn the user instead of silently dropping things. */
export interface MltLimitation {
  node: "clip" | "audio" | "text" | "composition";
  field: string;
  detail: string;
}

export interface MltBuildResult {
  xml: string;
  /** Output duration in frames at the chosen fps. */
  totalFrames: number;
  limitations: MltLimitation[];
}

export function buildMltDocument(
  timeline: ResolvedTimeline,
  options: MltOptions = {},
): MltBuildResult {
  const W = options.width ?? timeline.contentWidth ?? 1920;
  const H = options.height ?? timeline.contentHeight ?? 1080;
  const fps = options.fps ?? 30;
  const basePath = options.basePath;
  const textRasters = options.textRasters ?? new Map();
  const limitations: MltLimitation[] = [];

  const fr = (t: number) => Math.max(0, Math.round(t * fps));

  // ── Producers (deduped) ────────────────────────────────────────
  // Same media file referenced by many entries collapses to a single
  // producer; entries trim it via in/out frames.
  const producers = new Map<string, string>(); // id → xml
  const producerIdByResource = new Map<string, string>();
  let nextProdSeq = 0;
  const newProducerId = (prefix: string) => `${prefix}_${nextProdSeq++}`;

  function addMediaProducer(relPath: string): string {
    const fullPath = basePath ? resolve(basePath, relPath) : relPath;
    const cached = producerIdByResource.get(fullPath);
    if (cached) return cached;
    const id = newProducerId("src");
    producerIdByResource.set(fullPath, id);
    producers.set(
      id,
      `  <producer id="${id}" resource="${escAttr(fullPath)}"/>`,
    );
    return id;
  }

  function addTextProducer(node: ResolvedText, durationFrames: number): string | null {
    const raster = textRasters.get(node);
    if (!raster) {
      limitations.push({
        node: "text",
        field: "raster",
        detail: "ResolvedText had no rasterized PNG — call rasterizeAllText first",
      });
      return null;
    }
    if (raster.isAnimated) {
      // Animated text styles use a per-frame PNG sequence in the
      // ffmpeg path. The MLT image-list producer can pull a numbered
      // sequence too, but we haven't wired it yet.
      limitations.push({
        node: "text",
        field: "animated style",
        detail: `text-${node.runs.map((r) => r.text).join("").slice(0, 30)}: per-frame PNG sequence not yet bridged into MLT (using t=0 frame only)`,
      });
    }
    const cached = producerIdByResource.get(raster.path);
    if (cached) return cached;
    const id = newProducerId("text");
    producerIdByResource.set(raster.path, id);
    producers.set(
      id,
      [
        `  <producer id="${id}" in="0" out="${Math.max(0, durationFrames - 1)}" resource="${escAttr(raster.path)}">`,
        `    <property name="mlt_service">qimage</property>`,
        `    <property name="ttl">1</property>`,
        `  </producer>`,
      ].join("\n"),
    );
    return id;
  }

  // ── Segment collection ────────────────────────────────────────

  type ClipSeg = {
    kind: "clip";
    start: number;
    end: number;
    producer: string;
    sourceIn: number;
    sourceOut: number;
    speed: number;
    volume?: Keyframed<number>;
    node: ResolvedClip;
  };
  type AudioSeg = {
    kind: "audio";
    start: number;
    end: number;
    producer: string;
    sourceIn: number;
    sourceOut: number;
    speed: number;
    volume?: Keyframed<number>;
    node: ResolvedAudio;
  };
  type TextSeg = {
    kind: "text";
    start: number;
    end: number;
    producer: string;
    node: ResolvedText;
  };

  const clipSegs: ClipSeg[] = [];
  const audioSegs: AudioSeg[] = [];
  const textSegs: TextSeg[] = [];

  // Walk the resolved tree top-level only (composition already
  // flattened by `resolveComposition`/`resolveSpatial`). Nested
  // compositions aren't supported yet — flag them.
  for (const child of timeline.children) {
    collectChild(child);
  }

  function collectChild(child: ResolvedChild): void {
    if (child.type === "empty" || child.type === "data") return;
    if (child.type === "clip") {
      const prod = addMediaProducer(child.source);
      if (child.speed !== 1) {
        limitations.push({
          node: "clip",
          field: "speed",
          detail: `${child.source}: non-unity speed (${child.speed}x) not yet wired through MLT`,
        });
      }
      if ((child.spatial != null && child.spatial.x !== 0) ||
          (child.objectFit && child.objectFit !== "fit")) {
        // testedit's clips don't customize spatial; flag if encountered.
        limitations.push({
          node: "clip",
          field: "spatial",
          detail: `${child.source}: non-default clip spatial/objectFit not yet wired`,
        });
      }
      clipSegs.push({
        kind: "clip",
        start: child.timelineStart,
        end: child.timelineEnd,
        producer: prod,
        sourceIn: child.sourceIn,
        sourceOut: child.sourceOut,
        speed: child.speed,
        volume: child.volume,
        node: child,
      });
      if (child.filters?.length) {
        limitations.push({
          node: "clip",
          field: "filters",
          detail: `${child.source}: filters on clips not yet translated to MLT (${child.filters.map((f) => f.type).join(", ")})`,
        });
      }
      return;
    }
    if (child.type === "audio") {
      const prod = addMediaProducer(child.source);
      audioSegs.push({
        kind: "audio",
        start: child.timelineStart,
        end: child.timelineEnd,
        producer: prod,
        sourceIn: child.sourceIn,
        sourceOut: child.sourceOut,
        speed: child.speed,
        volume: child.volume,
        node: child,
      });
      return;
    }
    if (child.type === "text") {
      const dur = child.timelineEnd - child.timelineStart;
      const prod = addTextProducer(child, fr(dur));
      if (!prod) return;
      textSegs.push({
        kind: "text",
        start: child.timelineStart,
        end: child.timelineEnd,
        producer: prod,
        node: child,
      });
      // Flag any non-opacity filters; they'll need MLT filter chains.
      const unsupportedFilters = (child.filters ?? []).filter(
        (f) => f.type !== "opacity",
      );
      if (unsupportedFilters.length) {
        limitations.push({
          node: "text",
          field: "filters",
          detail: `non-opacity text filters not yet translated: ${unsupportedFilters.map((f) => f.type).join(", ")}`,
        });
      }
      return;
    }
    if (child.type === "composition") {
      limitations.push({
        node: "composition",
        field: "nesting",
        detail: "nested compositions not yet flattened to MLT — only top-level children render",
      });
      return;
    }
  }

  // ── Track packing ─────────────────────────────────────────────

  function packTracks<T extends { start: number; end: number }>(segs: T[]): T[][] {
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    const tracks: T[][] = [];
    for (const seg of sorted) {
      let placed = false;
      for (const t of tracks) {
        const last = t[t.length - 1];
        if (last.end <= seg.start) {
          t.push(seg);
          placed = true;
          break;
        }
      }
      if (!placed) tracks.push([seg]);
    }
    return tracks;
  }

  // Audio packing is fine — `mix` just sums, no per-frame geometry to
  // interpolate. Text gets one track per node so each composite
  // transition's keyframes are isolated.
  const audioTracks = packTracks(audioSegs);
  // Text segments sorted by start time so track indices are stable
  // across re-runs and loosely match timeline order.
  const textSegsSorted = [...textSegs].sort((a, b) => a.start - b.start);

  // ── Playlists ─────────────────────────────────────────────────

  let droppedSubFrame = 0;

  function renderClipPlaylist(id: string, segs: ClipSeg[]): string {
    const lines = [`  <playlist id="${id}">`];
    let cursor = 0;
    for (const seg of segs) {
      const startF = fr(seg.start);
      const endF = fr(seg.end);
      const segLen = endF - startF;
      if (segLen < 1) {
        droppedSubFrame++;
        continue;
      }
      if (startF > cursor) {
        lines.push(`    <blank length="${startF - cursor}"/>`);
      }
      const inF = fr(seg.sourceIn);
      const outF = inF + segLen - 1;
      lines.push(`    <entry producer="${seg.producer}" in="${inF}" out="${outF}"/>`);
      cursor = endF;
    }
    lines.push(`  </playlist>`);
    return lines.join("\n");
  }

  function renderAudioPlaylist(id: string, segs: AudioSeg[]): string {
    const lines = [`  <playlist id="${id}">`];
    let cursor = 0;
    for (const seg of segs) {
      const startF = fr(seg.start);
      const endF = fr(seg.end);
      const segLen = endF - startF;
      if (segLen < 1) continue;
      if (startF > cursor) {
        lines.push(`    <blank length="${startF - cursor}"/>`);
      }
      const inF = fr(seg.sourceIn);
      const outF = inF + segLen - 1;
      // Inline volume filter on the entry. Static unity volume is
      // skipped (default in MLT). Animated volume is logged as a
      // limitation; MLT's `volume` filter does support keyframed
      // `gain`, but we haven't bridged the keyframe-string path yet.
      let entry = `    <entry producer="${seg.producer}" in="${inF}" out="${outF}"`;
      if (seg.volume != null) {
        if (isKeyframed(seg.volume)) {
          limitations.push({
            node: "audio",
            field: "volume",
            detail: "animated volume not yet translated to MLT volume filter keyframes",
          });
        } else if (seg.volume !== 1) {
          entry += `>\n      <filter mlt_service="volume" gain="${fnum(seg.volume as number)}"/>\n    </entry`;
          lines.push(entry + ">");
          cursor = endF;
          continue;
        }
      }
      entry += "/>";
      lines.push(entry);
      cursor = endF;
    }
    lines.push(`  </playlist>`);
    return lines.join("\n");
  }

  /** A text track holds exactly one text — leading blank to push the
   *  entry to its start frame, the entry itself, and a trailing blank
   *  out to the tractor's full duration. The trailing blank is
   *  important: without it, melt has been observed to "extend" the
   *  qimage producer's last frame past the playlist end and the
   *  composite transition then keeps painting that frozen frame
   *  underneath later text overlays. With an explicit blank, the
   *  b_track is unambiguously empty post-entry. */
  function renderSingleTextPlaylist(id: string, seg: TextSeg, totalFrames: number): string {
    const startF = fr(seg.start);
    const endF = fr(seg.end);
    const segLen = endF - startF;
    if (segLen < 1) return "";
    const lines = [`  <playlist id="${id}">`];
    if (startF > 0) lines.push(`    <blank length="${startF}"/>`);
    lines.push(`    <entry producer="${seg.producer}" in="0" out="${segLen - 1}"/>`);
    const trailing = totalFrames - endF;
    if (trailing > 0) lines.push(`    <blank length="${trailing}"/>`);
    lines.push(`  </playlist>`);
    return lines.join("\n");
  }

  const totalFrames = fr(timeline.duration);
  const videoPlaylistId = "video_v0";
  const videoPlaylistXml = renderClipPlaylist(videoPlaylistId, clipSegs);
  // Each text gets its own track id `text_v<i>` so the tractor can
  // attach a unique composite transition to it. Track indices are
  // 1-based to leave 0 for the video track.
  const textTrackInfo: { id: string; seg: TextSeg }[] = [];
  const textPlaylistsXml: string[] = [];
  for (const seg of textSegsSorted) {
    const segLen = fr(seg.end) - fr(seg.start);
    if (segLen < 1) continue;
    const id = `text_v${textTrackInfo.length + 1}`;
    const xml = renderSingleTextPlaylist(id, seg, totalFrames);
    if (xml) {
      textTrackInfo.push({ id, seg });
      textPlaylistsXml.push(xml);
    }
  }
  const audioPlaylistsXml = audioTracks.map((segs, i) =>
    renderAudioPlaylist(`audio_a${i}`, segs),
  );

  // ── qtblend rect keyframes per text ──────────────────────────
  // Geometry frames are relative to the transition's `in` — frame 0
  // in the geometry = `in` in the tractor — so we count from 0..len
  // here instead of startF..endF. The transition's in/out clamps the
  // composite to [startF, endF], so we don't need the explicit
  // alpha=0 lead-in we previously emitted.
  function buildTextGeometry(seg: TextSeg): string {
    const text = seg.node;
    const len = fr(seg.end) - fr(seg.start);
    const dur = seg.end - seg.start;
    const spatialAnimated =
      text.spatialInput != null && hasAnimatedSpatialInput(text.spatialInput);
    const opacityAnimated = textHasAnimatedOpacity(text);
    const animated = spatialAnimated || opacityAnimated;

    const sampleAt = (frameOffset: number) => {
      const t = animated ? frameOffset / fps : 0;
      const container = sampleContainerRect(text, W, H, t, dur);
      const rect = applyObjectFit(
        container,
        text.contentWidth,
        text.contentHeight,
        text.objectFit,
        text.anchor,
      );
      const alpha = sampleOpacity(text, t, dur);
      return { rect, alpha };
    };

    const first = sampleAt(0);
    if (!animated) {
      // qtblend lerps every adjacent keyframe pair, so we hold alpha
      // at `len-1` to keep the rect solidly visible through the
      // active range and only snap to 0 at `len` (one past the last
      // visible frame).
      const parts = [`0=${formatGeometry(first.rect, first.alpha)}`];
      if (len > 1) {
        parts.push(`${len - 1}=${formatGeometry(first.rect, first.alpha)}`);
      }
      parts.push(`${len}=${formatGeometry(first.rect, 0)}`);
      return parts.join(";");
    }

    const parts: string[] = [];
    let prev: string | null = null;
    for (let local = 0; local <= len; local++) {
      const { rect, alpha } = sampleAt(local);
      const spec = formatGeometry(rect, alpha);
      if (spec !== prev || local === 0 || local === len) {
        parts.push(`${local}=${spec}`);
        prev = spec;
      }
    }
    return parts.join(";");
  }

  // ── Tractor ──────────────────────────────────────────────────

  const trackEntries: string[] = [`    <track producer="${videoPlaylistId}"/>`];
  for (const t of textTrackInfo) {
    trackEntries.push(`    <track producer="${t.id}"/>`);
  }
  const audioBase = 1 + textTrackInfo.length;
  for (let i = 0; i < audioTracks.length; i++) {
    trackEntries.push(`    <track producer="audio_a${i}" hide="video"/>`);
  }

  const transitionsXml: string[] = [];
  for (let i = 0; i < textTrackInfo.length; i++) {
    const trackIdx = 1 + i;
    const { seg } = textTrackInfo[i];
    const startF = fr(seg.start);
    const endF = fr(seg.end);
    const geometry = buildTextGeometry(seg);
    transitionsXml.push(
      [
        `    <transition>`,
        `      <property name="a_track">0</property>`,
        `      <property name="b_track">${trackIdx}</property>`,
        `      <property name="mlt_service">qtblend</property>`,
        `      <property name="compositing">over</property>`,
        `      <property name="in">${startF}</property>`,
        `      <property name="out">${endF - 1}</property>`,
        `      <property name="rect">${escAttr(geometry)}</property>`,
        `    </transition>`,
      ].join("\n"),
    );
  }
  for (let i = 0; i < audioTracks.length; i++) {
    transitionsXml.push(
      [
        `    <transition>`,
        `      <property name="a_track">0</property>`,
        `      <property name="b_track">${audioBase + i}</property>`,
        `      <property name="mlt_service">mix</property>`,
        `      <property name="combine">1</property>`,
        `    </transition>`,
      ].join("\n"),
    );
  }

  if (droppedSubFrame > 0) {
    limitations.push({
      node: "clip",
      field: "duration",
      detail: `${droppedSubFrame} clip(s) collapsed to <1 frame at ${fps}fps and were dropped`,
    });
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0" producer="main_tractor">
  <profile description="${W}x${H} ${fps}fps" width="${W}" height="${H}" frame_rate_num="${fps}" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${W}" display_aspect_den="${H}" colorspace="709" progressive="1"/>

${[...producers.values()].join("\n")}

${videoPlaylistXml}

${textPlaylistsXml.join("\n\n")}

${audioPlaylistsXml.join("\n\n")}

  <tractor id="main_tractor" in="0" out="${Math.max(0, totalFrames - 1)}">
${trackEntries.join("\n")}

${transitionsXml.join("\n")}
  </tractor>
</mlt>
`;

  return { xml, totalFrames, limitations };
}

// ── Helpers ────────────────────────────────────────────────────

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fnum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(3)).toString();
}

function formatGeometry(rect: SpatialRect, alpha: number): string {
  // qtblend's `rect` keyframe format: `X Y W H OPACITY` (space-separated,
  // opacity 0..1). composite's geometry is similar but with `/` and `x`
  // separators and 0..100 opacity — qtblend wins because it actually
  // honors per-frame opacity changes (composite's alpha was being
  // ignored on melt 7.38).
  return `${Math.round(rect.x)} ${Math.round(rect.y)} ${Math.round(rect.width)} ${Math.round(rect.height)} ${fnum(alpha)}`;
}

function sampleContainerRect(
  text: ResolvedText,
  parentW: number,
  parentH: number,
  t: number,
  duration: number,
): SpatialRect {
  if (text.spatialInput && hasAnimatedSpatialInput(text.spatialInput)) {
    const { spatial } = resolveBoxProps(
      text.spatialInput,
      parentW,
      parentH,
      t,
      duration,
    );
    return spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
  }
  return text.spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
}

/** Apply objectFit/anchor to compute the on-screen rect for the source
 *  PNG. Matches the preview's RenderList logic so the rendered output
 *  positions glyphs the same way the editor showed them. */
function applyObjectFit(
  container: SpatialRect,
  contentW: number,
  contentH: number,
  objectFit: ResolvedText["objectFit"],
  anchor: SpatialAnchor | undefined,
): SpatialRect {
  const fit = objectFit ?? "fit";
  let scale: number;
  if (fit === "fit") {
    scale = Math.min(container.width / contentW, container.height / contentH);
  } else if (fit === "cover") {
    scale = Math.max(container.width / contentW, container.height / contentH);
  } else {
    // center
    scale = 1;
  }
  const w = contentW * scale;
  const h = contentH * scale;
  let offsetX: number;
  if (anchor?.right != null && anchor?.left == null) offsetX = container.width - w;
  else if (anchor?.left != null && anchor?.right == null) offsetX = 0;
  else offsetX = (container.width - w) / 2;
  let offsetY: number;
  if (anchor?.bottom != null && anchor?.top == null) offsetY = container.height - h;
  else if (anchor?.top != null && anchor?.bottom == null) offsetY = 0;
  else offsetY = (container.height - h) / 2;
  return {
    x: container.x + offsetX,
    y: container.y + offsetY,
    width: w,
    height: h,
  };
}

function textHasAnimatedOpacity(text: ResolvedText): boolean {
  if (!text.filters) return false;
  for (const f of text.filters) {
    if (f.type === "opacity" && isKeyframed(f.value)) return true;
  }
  return false;
}

function sampleOpacity(text: ResolvedText, t: number, duration: number): number {
  if (!text.filters) return 1;
  let alpha = 1;
  for (const f of text.filters as Filter[]) {
    if (f.type !== "opacity") continue;
    const value = f.value;
    if (value == null) continue;
    if (isKeyframed(value)) {
      alpha *= sampleNumber(value, t, duration);
    } else {
      alpha *= value as number;
    }
  }
  return Math.max(0, Math.min(1, alpha));
}

// Suppress unused-symbol noise for types kept to support future
// extensions but not yet referenced inside this file.
void ((..._: unknown[]) => 0)({} as SpatialInput, {} as Filter);
