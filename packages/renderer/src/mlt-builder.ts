// Build an MLT XML document from a resolved seam timeline.
//
// Audio note: the timeline's clip and audio nodes contribute *no*
// audio to this graph. Instead, the caller pre-renders a single mixed
// audio file with ffmpeg (sample-accurate, no per-frame stepping
// artifacts) and passes its path via `options.audioFile`. We add it as
// a single producer + track. This keeps melt's render to a single
// pass while avoiding MLT's frame-grid audio splicing.
//
// Architecture:
//   - One <producer> per unique source (clips supply video only).
//   - One <producer> per text PNG (qimage service, ttl=1).
//   - One <producer> for the pre-rendered audio file when supplied.
//   - Track 0 (video): a single <playlist> of every clip in timeline
//     order; sequential clips back-to-back, blanks for any gaps.
//   - Tracks 1..N (text overlays): one track per text node. Each track
//     gets exactly one <composite> transition whose `in`/`out` clamp
//     it to the text's own time range and whose `geometry` frames are
//     relative to that `in`.
//   - Track N+1 (audio, when `audioFile` is set): one entry covering
//     the full duration; mixed into the master via a single mix
//     transition.
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
  /** Path to a pre-rendered audio file (any format ffmpeg/melt can
   *  read — typically aac or wav). Added as a single producer that
   *  spans the timeline; the audio in clip and audio nodes is
   *  intentionally not re-emitted by this builder. */
  audioFile?: string;
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
    // `audio_index=-1` disables the producer's audio stream entirely.
    // Without this, melt mixes each clip's source audio into the
    // master *in addition to* our pre-rendered audio file — which
    // shows up as flanging (two slightly-skewed copies of the same
    // signal) and roughly +6dB across the whole track.
    producers.set(
      id,
      [
        `  <producer id="${id}" resource="${escAttr(fullPath)}">`,
        `    <property name="audio_index">-1</property>`,
        `  </producer>`,
      ].join("\n"),
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
  type TextSeg = {
    kind: "text";
    start: number;
    end: number;
    producer: string;
    node: ResolvedText;
  };

  const clipSegs: ClipSeg[] = [];
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
      // Audio is rendered by the ffmpeg audio path; ignore it here.
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

  // (Track packing was removed — see the textSegsSorted comment
  // above. Each non-empty entry now lives on its own track.)

  // One track per non-empty entry across the board. Packing was an
  // optimization that turned out to buy nothing — melt's per-frame
  // cost scales with the number of *active* tracks at each moment,
  // not the total. And as the text-drift bug taught us, sharing a
  // track between siblings can introduce surprising cross-effects
  // (geometry interpolation between adjacent entries on a packed
  // composite, etc.). Sort by start time so track indices loosely
  // mirror timeline order, which keeps the project navigable in
  // GUI editors.
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

  // Track 0 is a uniform black base spanning the whole timeline.
  // Every other content track (video clips, text overlays, audio)
  // composites *onto this black background* via its own qtblend
  // transition with a_track=0. That keeps qtblend's "rect"
  // interpretation consistent across siblings — without the black
  // base, the actual video clips' source properties (Dolby Vision
  // HDR colorspace, non-square SAR, rotation metadata) seem to bleed
  // into how qtblend parses other transitions' rect values, sending
  // pixel coordinates into a percent-of-source frame.
  const bgPlaylistId = "bg_track";
  const bgProducerXml = [
    `  <producer id="bg" in="0" out="${Math.max(0, totalFrames - 1)}">`,
    `    <property name="mlt_service">color</property>`,
    `    <property name="resource">black</property>`,
    `  </producer>`,
  ].join("\n");
  const bgPlaylistXmlStr = [
    `  <playlist id="${bgPlaylistId}">`,
    `    <entry producer="bg" in="0" out="${Math.max(0, totalFrames - 1)}"/>`,
    `  </playlist>`,
  ].join("\n");

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

  // Pre-mixed audio file as a single producer + playlist + track.
  // Renders alongside the video without participating in the
  // composite chain (mix transition just sums it into the master).
  let audioProducerXml = "";
  let audioPlaylistXml = "";
  let audioTrackId: string | null = null;
  if (options.audioFile) {
    audioTrackId = "audio_track";
    audioProducerXml = `  <producer id="mixed_audio" resource="${escAttr(options.audioFile)}"/>`;
    audioPlaylistXml = [
      `  <playlist id="${audioTrackId}">`,
      `    <entry producer="mixed_audio" in="0" out="${Math.max(0, totalFrames - 1)}"/>`,
      `  </playlist>`,
    ].join("\n");
  }

  // ── qtblend rect per text ────────────────────────────────────
  // Static texts emit a single non-keyframed rect. Animated texts
  // emit `frame=spec` keyframes relative to the transition's `in`
  // (frame 0 in the geometry = `in` in the tractor), one per output
  // frame the value changes; RLE-collapsed.
  //
  // The two forms are *not* interchangeable to qtblend: the moment
  // the rect string contains a keyframe (`=`), qtblend appears to
  // re-interpret bare numbers as percentages instead of pixels, which
  // sends y=-800 to y=0 (clamped) and explains the (0,0) drift we
  // saw when ¥400 coexisted with another animated overlay.
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

    if (!animated) {
      // Single static rect — no `=` anywhere. qtblend treats this as
      // a constant pixel rect, and the transition's in/out handles
      // the show/hide window for us.
      const { rect, alpha } = sampleAt(0);
      return formatGeometry(rect, alpha);
    }

    // Animated: one keyframe per output frame the value changes,
    // RLE-collapsed. We don't emit an alpha-drop keyframe past the
    // last visible frame because the transition's in/out already
    // makes everything outside [0, len-1] inactive.
    const parts: string[] = [];
    let prev: string | null = null;
    const last = len - 1;
    for (let local = 0; local <= last; local++) {
      const { rect, alpha } = sampleAt(local);
      const spec = formatGeometry(rect, alpha);
      if (spec !== prev || local === 0 || local === last) {
        parts.push(`${local}=${spec}`);
        prev = spec;
      }
    }
    return parts.join(";");
  }

  // ── Tractor ──────────────────────────────────────────────────
  // Track layout:
  //   0 = bg (uniform black, full duration)
  //   1 = video clips
  //   2..N+1 = text overlays
  //   N+2 = audio (when present)

  const trackEntries: string[] = [
    `    <track producer="${bgPlaylistId}"/>`,
    `    <track producer="${videoPlaylistId}"/>`,
  ];
  const videoTrackIdx = 1;
  const textTrackBase = 2;
  for (const t of textTrackInfo) {
    trackEntries.push(`    <track producer="${t.id}"/>`);
  }
  let audioTrackIdx: number | null = null;
  if (audioTrackId) {
    audioTrackIdx = textTrackBase + textTrackInfo.length;
    trackEntries.push(`    <track producer="${audioTrackId}" hide="video"/>`);
  }

  const transitionsXml: string[] = [];

  // Video composite: fills the canvas. No in/out — active for the
  // whole timeline. Blanks in the video playlist (gaps between
  // clips) just leave the bg showing through.
  transitionsXml.push(
    [
      `    <transition>`,
      `      <property name="a_track">0</property>`,
      `      <property name="b_track">${videoTrackIdx}</property>`,
      `      <property name="mlt_service">qtblend</property>`,
      `      <property name="compositing">over</property>`,
      `      <property name="rect">0 0 ${W} ${H} 1</property>`,
      `    </transition>`,
    ].join("\n"),
  );

  for (let i = 0; i < textTrackInfo.length; i++) {
    const trackIdx = textTrackBase + i;
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
  if (audioTrackIdx != null) {
    transitionsXml.push(
      [
        `    <transition>`,
        `      <property name="a_track">0</property>`,
        `      <property name="b_track">${audioTrackIdx}</property>`,
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

${bgProducerXml}
${[...producers.values()].join("\n")}
${audioProducerXml ? `\n${audioProducerXml}\n` : ""}
${bgPlaylistXmlStr}

${videoPlaylistXml}

${textPlaylistsXml.join("\n\n")}
${audioPlaylistXml ? `\n${audioPlaylistXml}\n` : ""}
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
