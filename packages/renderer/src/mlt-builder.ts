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
  AdjustFilter,
  ColorBalanceFilter,
  ColorTemperatureFilter,
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
import { bakePwl, pwlToMltKeyframes } from "./animation/expr.js";
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

  function addMediaProducer(relPath: string, speed: number): string {
    const fullPath = basePath ? resolve(basePath, relPath) : relPath;
    // Dedup by (path, speed): two clips on the same source at
    // different speeds need separate timewarp producers because the
    // producer's frame coordinates are post-warp.
    const cacheKey = `${fullPath}@${speed}`;
    const cached = producerIdByResource.get(cacheKey);
    if (cached) return cached;
    const id = newProducerId("src");
    producerIdByResource.set(cacheKey, id);
    // For speed != 1 we wrap the source in MLT's `timewarp` service.
    // The XML loader needs `mlt_service` set explicitly — it doesn't
    // parse `service:args` out of `resource` the way the CLI loader
    // does, so without this it treats the whole `timewarp:S:path`
    // string as a filename and fails with "failed to load producer".
    // The resource form here is `S:path`; we also set warp_speed /
    // warp_resource explicitly because Shotcut/Kdenlive do, and
    // older melt builds rely on those to avoid re-parsing.
    //
    // `audio_index=-1` disables the producer's audio stream entirely.
    // Without this, melt mixes each clip's source audio into the
    // master *in addition to* our pre-rendered audio file — which
    // shows up as flanging (two slightly-skewed copies of the same
    // signal) and roughly +6dB across the whole track.
    const lines: string[] = [];
    if (speed === 1) {
      lines.push(`  <producer id="${id}" resource="${escAttr(fullPath)}">`);
      lines.push(`    <property name="audio_index">-1</property>`);
    } else {
      lines.push(`  <producer id="${id}" resource="${escAttr(`${speed}:${fullPath}`)}">`);
      lines.push(`    <property name="mlt_service">timewarp</property>`);
      lines.push(`    <property name="warp_speed">${speed}</property>`);
      lines.push(`    <property name="warp_resource">${escAttr(fullPath)}</property>`);
      lines.push(`    <property name="warp_pitch">0</property>`);
      lines.push(`    <property name="audio_index">-1</property>`);
    }
    lines.push(`  </producer>`);
    producers.set(id, lines.join("\n"));
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
    // Animated text resolves to a printf-style numbered sequence
    // (e.g. `text-3-%04d.png`); the qimage service with `ttl=1`
    // advances one PNG per output frame, so animated styles "just
    // work" without any extra plumbing here.
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
    /** Plain clips (full canvas, fit/undefined objectFit) ride on the
     *  shared video playlist; positioned ones get their own track so
     *  qtblend can give them a per-clip rect. */
    positioned: boolean;
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

  // Walk the resolved tree, recursing into nested compositions and
  // compounding their timeline offset and speed onto inner children.
  // Composition wrapper props (spatial/filters/contentSize) are not
  // honored — see the warning below — but the inner content renders
  // with correct absolute timing.
  for (const child of timeline.children) {
    collectChild(child, 0, 1);
  }

  function collectChild(
    child: ResolvedChild,
    offset: number,
    parentSpeed: number,
  ): void {
    if (child.type === "empty" || child.type === "data") return;
    // Map the child's local-to-parent timeline range into absolute
    // outer-timeline coords. Same math as core's `flattenResolved`:
    // a slower parent (speed<1) stretches inner durations.
    const start = offset + child.timelineStart / parentSpeed;
    const end = offset + child.timelineEnd / parentSpeed;
    if (child.type === "clip") {
      const compoundSpeed = child.speed * parentSpeed;
      const prod = addMediaProducer(child.source, compoundSpeed);
      const positioned = isClipPositioned(child);
      // qtblend always stretches the source to fit its rect, so non-fit
      // objectFit values ("cover", "center") aren't honored unless we
      // also know the source's intrinsic dims. Flag it so the user
      // knows the rect is being stretched-to-fit instead of cropped/
      // centered.
      if (child.objectFit && child.objectFit !== "fit") {
        limitations.push({
          node: "clip",
          field: "objectFit",
          detail: `${child.source}: objectFit="${child.objectFit}" stretches to rect (qtblend has no native cover/center mode)`,
        });
      }
      clipSegs.push({
        kind: "clip",
        start,
        end,
        producer: prod,
        sourceIn: child.sourceIn,
        sourceOut: child.sourceOut,
        speed: compoundSpeed,
        volume: child.volume,
        node: child,
        positioned,
      });
      return;
    }
    if (child.type === "audio") {
      // Audio is rendered by the ffmpeg audio path; ignore it here.
      return;
    }
    if (child.type === "text") {
      const dur = end - start;
      const prod = addTextProducer(child, fr(dur));
      if (!prod) return;
      textSegs.push({
        kind: "text",
        start,
        end,
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
      // Wrapper props (spatial/objectFit/filters/contentWidth/Height)
      // aren't applied to the flattened inner content — flag if any
      // are non-default so the user knows the wrapping is being
      // discarded. `objectFit: "fit"` is the resolver's default and
      // doesn't count.
      const hasSpatial =
        child.spatial != null || child.spatialInput != null;
      const hasFit = child.objectFit != null && child.objectFit !== "fit";
      const hasFilters = child.filters && child.filters.length > 0;
      const hasContent =
        child.contentWidth != null || child.contentHeight != null;
      if (hasSpatial || hasFit || hasFilters || hasContent) {
        limitations.push({
          node: "composition",
          field: "wrapper",
          detail:
            "nested composition with spatial/objectFit/filters/contentSize: inner children render but the wrapper transform isn't applied",
        });
      }
      const compSpeed = child.speed * parentSpeed;
      for (const grandchild of child.children) {
        collectChild(grandchild, start, compSpeed);
      }
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

  /** Round a clip to its on-grid (start, end) frames with a 1-frame
   *  floor on length. Sub-frame clips that round to 0 frames get
   *  bumped up to a single frame at the rounded start; if that pushes
   *  past where the next clip starts, the next clip's blank logic
   *  will absorb the slip (no overlap, no drop). */
  function clipFrameSpan(seg: ClipSeg): { startF: number; endF: number } {
    const startF = fr(seg.start);
    let endF = fr(seg.end);
    if (endF <= startF) endF = startF + 1;
    return { startF, endF };
  }

  function renderClipPlaylist(id: string, segs: ClipSeg[]): string {
    const lines = [`  <playlist id="${id}">`];
    let cursor = 0;
    for (const seg of segs) {
      const { startF, endF } = clipFrameSpan(seg);
      const segLen = endF - startF;
      // Positioned clips render on their own dedicated track so
      // qtblend can give them a per-clip rect. They DON'T contribute
      // to the shared playlist, but the gap they leave is left as
      // implicit (the next plain clip's blank logic naturally fills
      // it because we don't advance `cursor`).
      if (seg.positioned) continue;
      // Snap forward if this clip's nominal start is before the
      // running cursor (can happen when an earlier sub-frame clip
      // got bumped up to 1 frame). The entry just plays a tick later
      // — preferable to dropping it.
      const effectiveStartF = Math.max(startF, cursor);
      if (effectiveStartF > cursor) {
        lines.push(`    <blank length="${effectiveStartF - cursor}"/>`);
      }
      // Producer is plain avformat for speed=1 and timewarp:S:path
      // otherwise. In both cases producer-frame N corresponds to
      // source-frame N×speed, so we divide sourceIn by speed before
      // converting to frames. segLen is in *timeline* frames, which
      // is also what timewarp's producer counts in.
      const inF = Math.max(0, Math.round((seg.sourceIn / seg.speed) * fps));
      const outF = inF + segLen - 1;
      lines.push(`    <entry producer="${seg.producer}" in="${inF}" out="${outF}"/>`);
      cursor = effectiveStartF + segLen;
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

  /** Same as renderSingleTextPlaylist but for a positioned clip
   *  (which trims its source via in/out frames) — the in/out math
   *  matches what `renderClipPlaylist` does for plain clips, so
   *  timewarp-wrapped producers keep working.
   *
   *  Non-opacity filters (adjust / colorbalance / colortemperature)
   *  are emitted as MLT `<filter>` children of the playlist, clamped
   *  to the entry's playlist-local frame range so blanks stay clean. */
  function renderSinglePositionedClipPlaylist(
    id: string,
    seg: ClipSeg,
    totalFrames: number,
  ): string {
    const { startF, endF } = clipFrameSpan(seg);
    const segLen = endF - startF;
    const lines = [`  <playlist id="${id}">`];
    if (startF > 0) lines.push(`    <blank length="${startF}"/>`);
    const inF = Math.max(0, Math.round((seg.sourceIn / seg.speed) * fps));
    const outF = inF + segLen - 1;
    lines.push(`    <entry producer="${seg.producer}" in="${inF}" out="${outF}"/>`);
    const trailing = totalFrames - endF;
    if (trailing > 0) lines.push(`    <blank length="${trailing}"/>`);
    // Filter coordinates are playlist-local. The entry sits at frames
    // [startF, startF + segLen - 1] in playlist coords (after the
    // leading blank).
    const filterIn = startF;
    const filterOut = startF + segLen - 1;
    const dur = seg.end - seg.start;
    const filtersXml = compileNonOpacityFilters(seg.node.filters, filterIn, filterOut, dur);
    if (filtersXml) lines.push(filtersXml);
    lines.push(`  </playlist>`);
    return lines.join("\n");
  }

  function compileNonOpacityFilters(
    filters: Filter[] | undefined,
    inF: number,
    outF: number,
    duration: number,
  ): string {
    if (!filters || filters.length === 0) return "";
    const blocks: string[] = [];
    for (const f of filters) {
      if (f.type === "opacity") continue; // folded into qtblend rect alpha
      let block: string | null = null;
      if (f.type === "adjust") block = compileAdjustFilter(f, inF, outF, duration);
      else if (f.type === "colorbalance") block = compileColorBalanceFilter(f, inF, outF, duration);
      else if (f.type === "colortemperature") block = compileColorTemperatureFilter(f, inF, outF, duration);
      if (block) blocks.push(block);
    }
    return blocks.join("\n");
  }

  /** Compile a `Keyframed<number>` to an MLT property value. Static
   *  values become bare numbers; animated values bake to PWL and
   *  convert to MLT's `frame=value;…` keyframe syntax (frames are
   *  shifted by `frameOffset` so they land in playlist-local space). */
  function compileKeyframedProp(
    value: Keyframed<number>,
    duration: number,
    frameOffset: number,
  ): string {
    const pwl = bakePwl(value, duration, fps);
    return pwlToMltKeyframes(pwl, fps, frameOffset);
  }

  function compileAdjustFilter(
    f: AdjustFilter,
    inF: number,
    outF: number,
    duration: number,
  ): string {
    // Wraps ffmpeg's `eq` filter — same parameter semantics as seam:
    // brightness is a -1..1 offset, contrast/saturation/gamma are
    // multipliers around 1.
    //
    // `av.eval=frame` tells ffmpeg's eq to re-evaluate parameters per
    // frame; MLT's avfilter wrapper updates `av.*` properties on each
    // frame, and eq's `process_command` picks them up.
    const lines = [
      `    <filter in="${inF}" out="${outF}">`,
      `      <property name="mlt_service">avfilter.eq</property>`,
      `      <property name="av.eval">frame</property>`,
    ];
    if (f.brightness != null) lines.push(`      <property name="av.brightness">${escAttr(compileKeyframedProp(f.brightness, duration, inF))}</property>`);
    if (f.contrast != null) lines.push(`      <property name="av.contrast">${escAttr(compileKeyframedProp(f.contrast, duration, inF))}</property>`);
    if (f.saturation != null) lines.push(`      <property name="av.saturation">${escAttr(compileKeyframedProp(f.saturation, duration, inF))}</property>`);
    if (f.gamma != null) lines.push(`      <property name="av.gamma">${escAttr(compileKeyframedProp(f.gamma, duration, inF))}</property>`);
    lines.push(`    </filter>`);
    return lines.join("\n");
  }

  function compileColorBalanceFilter(
    f: ColorBalanceFilter,
    inF: number,
    outF: number,
    duration: number,
  ): string {
    // Wraps ffmpeg's `colorbalance` (rs/gs/bs shadow, rm/gm/bm
    // midtones, rh/gh/bh highlights — each -1..1).
    const lines = [
      `    <filter in="${inF}" out="${outF}">`,
      `      <property name="mlt_service">avfilter.colorbalance</property>`,
    ];
    const channels: Array<keyof ColorBalanceFilter> = ["rs", "gs", "bs", "rm", "gm", "bm", "rh", "gh", "bh"];
    for (const k of channels) {
      const v = f[k];
      if (v == null) continue;
      lines.push(`      <property name="av.${k}">${escAttr(compileKeyframedProp(v as Keyframed<number>, duration, inF))}</property>`);
    }
    lines.push(`    </filter>`);
    return lines.join("\n");
  }

  function compileColorTemperatureFilter(
    f: ColorTemperatureFilter,
    inF: number,
    outF: number,
    duration: number,
  ): string {
    // Wraps ffmpeg's `colortemperature` filter. Default 6500K is
    // neutral; lower values warm the image, higher cool it.
    const lines = [
      `    <filter in="${inF}" out="${outF}">`,
      `      <property name="mlt_service">avfilter.colortemperature</property>`,
    ];
    if (f.temperature != null) {
      lines.push(`      <property name="av.temperature">${escAttr(compileKeyframedProp(f.temperature, duration, inF))}</property>`);
    }
    lines.push(`    </filter>`);
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

  // Each positioned clip rides its own track + transition so qtblend
  // can hand it a per-clip rect. Plain clips stay in the shared
  // video playlist. Sort by start time so track indices loosely
  // mirror timeline order.
  const positionedClipsSorted = clipSegs
    .filter((s) => s.positioned)
    .sort((a, b) => a.start - b.start);
  const clipTrackInfo: { id: string; seg: ClipSeg }[] = [];
  const clipPlaylistsXml: string[] = [];
  for (const seg of positionedClipsSorted) {
    const segLen = fr(seg.end) - fr(seg.start);
    if (segLen < 1) continue;
    const id = `clip_v${clipTrackInfo.length + 1}`;
    const xml = renderSinglePositionedClipPlaylist(id, seg, totalFrames);
    if (xml) {
      clipTrackInfo.push({ id, seg });
      clipPlaylistsXml.push(xml);
    }
  }

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
  function buildOverlayGeometry(seg: TextSeg | ClipSeg): string {
    const node = seg.node;
    const len = fr(seg.end) - fr(seg.start);
    const dur = seg.end - seg.start;
    const spatialAnimated =
      node.spatialInput != null && hasAnimatedSpatialInput(node.spatialInput);
    const opacityAnimated = nodeHasAnimatedOpacity(node);
    const animated = spatialAnimated || opacityAnimated;

    const sampleAt = (frameOffset: number) => {
      const t = animated ? frameOffset / fps : 0;
      const container = sampleContainerRect(node, W, H, t, dur);
      let rect: SpatialRect;
      if (seg.kind === "text") {
        // Text PNGs carry their own intrinsic dims, so applyObjectFit
        // can place them inside the container (fit/cover/center).
        const text = node as ResolvedText;
        rect = applyObjectFit(
          container,
          text.contentWidth,
          text.contentHeight,
          text.objectFit,
          text.anchor,
        );
      } else {
        // Clips don't have intrinsic dims at build time (we'd need to
        // ffprobe each source), so we just hand the container rect to
        // qtblend — which stretches the source to fill it. Non-fit
        // objectFit values are flagged separately.
        rect = container;
      }
      const alpha = sampleNodeOpacity(node, t, dur);
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
  //   1 = shared video clips (plain clips only)
  //   2..C+1 = positioned clips (one per track)
  //   C+2..C+T+1 = text overlays (one per track)
  //   last = audio (when present)
  //
  // Compositing order matches transition emit order: bg < shared
  // video < positioned clips < text < audio. So a positioned clip
  // appears as a PIP over the canvas and text still lands on top.

  const trackEntries: string[] = [
    `    <track producer="${bgPlaylistId}"/>`,
    `    <track producer="${videoPlaylistId}"/>`,
  ];
  const videoTrackIdx = 1;
  const clipTrackBase = 2;
  for (const c of clipTrackInfo) {
    trackEntries.push(`    <track producer="${c.id}"/>`);
  }
  const textTrackBase = clipTrackBase + clipTrackInfo.length;
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
  // clips, or where positioned clips live) just leave the bg
  // showing through.
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

  for (let i = 0; i < clipTrackInfo.length; i++) {
    const trackIdx = clipTrackBase + i;
    const { seg } = clipTrackInfo[i];
    const { startF, endF } = clipFrameSpan(seg);
    const geometry = buildOverlayGeometry(seg);
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

  for (let i = 0; i < textTrackInfo.length; i++) {
    const trackIdx = textTrackBase + i;
    const { seg } = textTrackInfo[i];
    const startF = fr(seg.start);
    const endF = fr(seg.end);
    const geometry = buildOverlayGeometry(seg);
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


  const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0" producer="main_tractor">
  <profile description="${W}x${H} ${fps}fps" width="${W}" height="${H}" frame_rate_num="${fps}" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${W}" display_aspect_den="${H}" colorspace="709" progressive="1"/>

${bgProducerXml}
${[...producers.values()].join("\n")}
${audioProducerXml ? `\n${audioProducerXml}\n` : ""}
${bgPlaylistXmlStr}

${videoPlaylistXml}

${clipPlaylistsXml.join("\n\n")}${clipPlaylistsXml.length > 0 ? "\n\n" : ""}${textPlaylistsXml.join("\n\n")}
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

/** A clip needs its own track when (a) its display rect isn't the
 *  full canvas, (b) objectFit is non-fit, or (c) it has any filter
 *  (filters attach to the dedicated playlist, opacity also needs
 *  the per-clip qtblend transition for animated alpha). Plain clips
 *  ride the shared video playlist. */
function isClipPositioned(clip: ResolvedClip): boolean {
  if (clip.spatial != null) return true;
  if (clip.spatialInput != null) return true;
  if (clip.objectFit && clip.objectFit !== "fit") return true;
  if (clip.filters && clip.filters.length > 0) return true;
  return false;
}

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
  node: { spatialInput?: SpatialInput; spatial?: SpatialRect },
  parentW: number,
  parentH: number,
  t: number,
  duration: number,
): SpatialRect {
  if (node.spatialInput && hasAnimatedSpatialInput(node.spatialInput)) {
    const { spatial } = resolveBoxProps(
      node.spatialInput,
      parentW,
      parentH,
      t,
      duration,
    );
    return spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
  }
  return node.spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
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

function nodeHasAnimatedOpacity(node: { filters?: Filter[] }): boolean {
  if (!node.filters) return false;
  for (const f of node.filters) {
    if (f.type === "opacity" && isKeyframed(f.value)) return true;
  }
  return false;
}

function sampleNodeOpacity(
  node: { filters?: Filter[] },
  t: number,
  duration: number,
): number {
  if (!node.filters) return 1;
  let alpha = 1;
  for (const f of node.filters) {
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
