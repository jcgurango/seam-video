import { resolve } from "node:path";
import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  ResolvedAudio,
  ResolvedText,
  SpatialRect,
  SpatialAnchor,
  ObjectFit,
  Filter,
  Keyframed,
} from "@seam/core";
import { isKeyframed } from "@seam/core";
import type { TextRasterMap } from "./text/textRaster.js";
import {
  bakePwl,
  bakeSpatialPwl,
  isConstant,
  pwlToExpression,
  pwlToSendcmdCommands,
  type SpatialPwl,
} from "./animation/expr.js";
import { hasAnimatedSpatialInput } from "@seam/core";

/**
 * Per-input prefix flags. Plain strings are still accepted (most clips
 * don't need any prefix); reserved here for future per-input options.
 */
export interface FfmpegInput {
  path: string;
  flags?: string[];
}

export interface FfmpegCommand {
  inputs: FfmpegInput[];
  filterComplex: string;
  outputArgs: string[];
}

export interface FfmpegOptions {
  width?: number;
  height?: number;
  fps?: number;
  basePath?: string;
  /** Pre-rasterized PNGs for each ResolvedText in the tree, keyed by
   *  identity. Populated by `rasterizeAllText` before this builder runs. */
  textRasters?: TextRasterMap;
}

interface BuildContext {
  inputs: FfmpegInput[];
  filters: string[];
  segmentIndex: number;
  options: Required<Omit<FfmpegOptions, "basePath" | "textRasters">>;
  basePath: string | undefined;
  textRasters: TextRasterMap;
}

/**
 * Dedupe ffmpeg `-i` inputs by `(path, flags)` so a single source file
 * referenced by multiple clips/audio nodes still produces only one input
 * (and one decoder pass) — multiple filter chains can read from the same
 * `[N:v]` / `[N:a]` stream.
 */
function getOrAddInput(
  ctx: BuildContext,
  path: string,
  flags?: string[]
): number {
  const wantFlags = flags ?? [];
  for (let i = 0; i < ctx.inputs.length; i++) {
    const existing = ctx.inputs[i];
    if (existing.path !== path) continue;
    const haveFlags = existing.flags ?? [];
    if (haveFlags.length !== wantFlags.length) continue;
    let match = true;
    for (let j = 0; j < wantFlags.length; j++) {
      if (haveFlags[j] !== wantFlags[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  const idx = ctx.inputs.length;
  ctx.inputs.push(flags ? { path, flags } : { path });
  return idx;
}

export function buildFfmpegCommand(
  timeline: ResolvedTimeline,
  outputPath: string,
  options: FfmpegOptions = {}
): FfmpegCommand {
  // Animated properties need per-frame evaluation, which the editor preview
  // does but ffmpeg's static filter graph can't (without going through
  // sendcmd / per-frame expression scripting we haven't implemented).
  // Bail loudly so the user knows.
  assertNoAnimation(timeline.children);

  const opts: Required<Omit<FfmpegOptions, "basePath" | "textRasters">> = {
    width: options.width ?? timeline.contentWidth ?? 1920,
    height: options.height ?? timeline.contentHeight ?? 1080,
    fps: options.fps ?? 30,
  };

  const ctx: BuildContext = {
    inputs: [],
    filters: [],
    segmentIndex: 0,
    options: opts,
    basePath: options.basePath,
    textRasters: options.textRasters ?? new Map(),
  };

  const { v, a } = buildCompositeSegment(ctx, timeline.children, timeline.duration, 1);

  // Route to output labels
  ctx.filters.push(`${v}copy[outv]`, `${a}acopy[outa]`);

  return {
    inputs: ctx.inputs,
    filterComplex: ctx.filters.join(";\n"),
    outputArgs: [
      "-map", "[outv]",
      "-map", "[outa]",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      outputPath,
    ],
  };
}

/**
 * Build a list of children into a single {v, a} pair by creating a black base
 * and overlaying each child at its timelineStart offset. Overlapping
 * children (from composition attachments) are stacked in array order.
 */
function buildCompositeSegment(
  ctx: BuildContext,
  children: ResolvedChild[],
  duration: number,
  parentSpeed: number,
  containerW?: number,
  containerH?: number
): { v: string; a: string } {
  const totalDur = snapToFrame(duration / parentSpeed, ctx.options.fps);
  const width = containerW ?? ctx.options.width;
  const height = containerH ?? ctx.options.height;
  const { fps } = ctx.options;

  // Collect non-empty children as built segments with their time offsets.
  // Audio-only segments contribute no `v` label — the overlay chain skips
  // them and they're mixed straight into the audio output.
  const childSegments: {
    v?: string;
    a: string;
    delay: number;
    spatial?: SpatialRect;
    /** Per-frame x/y/w/h samples for nodes whose spatial edges are
     *  keyframed. Carried alongside the static `spatial` rect (which
     *  is the t=0 fallback) so the overlay step can drive ffmpeg
     *  expressions instead of fixed positions. */
    spatialPwl?: SpatialPwl;
  }[] = [];
  for (const child of children) {
    if (child.type === "empty" || child.type === "data") continue;
    const delay = snapToFrame(child.timelineStart / parentSpeed, ctx.options.fps);

    // Bake spatial PWL once per child if any edge is animated. Samples
    // are in the *node-local* output time (post-speed); the overlay
    // step shifts to parent timeline by `delay`.
    const inp = (child as { spatialInput?: import("@seam/core").SpatialInput }).spatialInput;
    const animated = inp != null && hasAnimatedSpatialInput(inp);
    const childOutputDuration =
      (child.timelineEnd - child.timelineStart) / parentSpeed;
    const spatialPwl = animated
      ? bakeSpatialPwl(inp!, width, height, childOutputDuration, fps)
      : undefined;

    const label = buildSingleSegment(ctx, child, parentSpeed, width, height, spatialPwl);
    const spatial = (child as { spatial?: SpatialRect }).spatial;
    childSegments.push({ ...label, delay, spatial, spatialPwl });
  }

  // If no visible children, return pure black
  if (childSegments.length === 0) {
    return buildBlackSegment(ctx, totalDur);
  }

  // Create black base for the full duration
  const baseSeg = ctx.segmentIndex++;
  const baseV = `[base${baseSeg}]`;
  ctx.filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${totalDur},setsar=1${baseV}`
  );

  // Chain overlay filters: base ← child0 ← child1 ← ...
  let currentV = baseV;
  const audioLabels: string[] = [];

  for (const child of childSegments) {
    const seg = ctx.segmentIndex++;
    let childV = child.v;
    let childA = child.a;

    // Delay child if it doesn't start at t=0
    if (child.delay > 0) {
      if (childV != null) {
        const delayedV = `[dv${seg}]`;
        ctx.filters.push(
          `${childV}format=yuva420p,tpad=start_duration=${child.delay}:color=black@0${delayedV}`
        );
        childV = delayedV;
      }

      const delayMs = Math.round(child.delay * 1000);
      const delayedA = `[da${seg}]`;
      ctx.filters.push(
        `${childA}adelay=${delayMs}|${delayMs}${delayedA}`
      );
      childA = delayedA;
    }

    // Overlay child on top of current result (skipped for audio-only).
    if (childV != null) {
      const resultV = `[comp${seg}]`;
      let overlayArgs: string;
      if (child.spatialPwl) {
        // Animated position: drive overlay's x/y per frame. The base
        // stream's `t` is parent timeline time, so PWL samples (in
        // node-local time) get shifted by the child's start delay.
        const xExpr = pwlToExpression(child.spatialPwl.x, child.delay);
        const yExpr = pwlToExpression(child.spatialPwl.y, child.delay);
        overlayArgs = `x='${xExpr}':y='${yExpr}':eval=frame:eof_action=pass`;
      } else {
        const ox = child.spatial ? child.spatial.x : 0;
        const oy = child.spatial ? child.spatial.y : 0;
        overlayArgs = `${ox}:${oy}:eof_action=pass`;
      }
      ctx.filters.push(
        `${currentV}${childV}overlay=${overlayArgs}${resultV}`,
      );
      currentV = resultV;
    }
    audioLabels.push(childA);
  }

  // Mix audio from all children
  let resultA: string;
  if (audioLabels.length === 0) {
    const silenceSeg = ctx.segmentIndex++;
    resultA = `[sil${silenceSeg}]`;
    ctx.filters.push(
      `anullsrc=r=48000:cl=stereo[sil${silenceSeg}_pre];[sil${silenceSeg}_pre]atrim=0:${totalDur}${resultA}`
    );
  } else if (audioLabels.length === 1) {
    resultA = audioLabels[0];
  } else {
    const seg = ctx.segmentIndex++;
    resultA = `[amix${seg}]`;
    ctx.filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0${resultA}`
    );
  }

  return { v: currentV, a: resultA };
}

/**
 * Build a single resolved child into one {v?, a} label pair. Audio-only
 * segments return without a video label.
 */
function buildSingleSegment(
  ctx: BuildContext,
  child: ResolvedChild,
  parentSpeed: number,
  parentW: number,
  parentH: number,
  spatialPwl?: SpatialPwl,
): { v?: string; a: string } {
  if (child.type === "clip") {
    return buildClipSegment(ctx, child, parentSpeed, parentW, parentH, spatialPwl);
  }
  if (child.type === "audio") {
    return buildAudioSegment(ctx, child, parentSpeed);
  }
  if (child.type === "empty" || child.type === "data") {
    return buildBlackSegment(ctx, snapToFrame((child.timelineEnd - child.timelineStart) / parentSpeed, ctx.options.fps));
  }
  if (child.type === "text") {
    return buildTextSegment(ctx, child, parentSpeed, parentW, parentH, spatialPwl);
  }
  // Composition: recurse into children
  const compoundSpeed = child.speed * parentSpeed;
  const displayW = child.spatial ? child.spatial.width : parentW;
  const displayH = child.spatial ? child.spatial.height : parentH;
  const innerW = child.contentWidth ?? displayW;
  const innerH = child.contentHeight ?? displayH;
  let result = buildCompositeSegment(ctx, child.children, child.duration, compoundSpeed, innerW, innerH);

  // Scale from inner to display size. When the composition's own spatial
  // is animated, the display size varies per frame — drive scale's
  // w/h with expressions and `eval=frame`.
  const displaySizeAnimated = spatialPwl != null;
  if (displaySizeAnimated) {
    const seg = ctx.segmentIndex++;
    const scaledV = `[scaled${seg}]`;
    const wExpr = pwlToExpression(spatialPwl.w);
    const hExpr = pwlToExpression(spatialPwl.h);
    ctx.filters.push(
      `${result.v}scale=w='${wExpr}':h='${hExpr}':eval=frame${scaledV}`,
    );
    result = { v: scaledV, a: result.a };
  } else if (innerW !== displayW || innerH !== displayH) {
    const seg = ctx.segmentIndex++;
    const scaledV = `[scaled${seg}]`;
    ctx.filters.push(
      `${result.v}scale=${Math.round(displayW)}:${Math.round(displayH)}${scaledV}`
    );
    result = { v: scaledV, a: result.a };
  }

  // Apply filters to the composite result
  if (child.filters?.length) {
    const filterStr = buildFilterChain(child.filters, ctx, child.duration / compoundSpeed);
    if (filterStr) {
      const seg = ctx.segmentIndex++;
      const filteredV = `[filt${seg}]`;
      ctx.filters.push(`${result.v}${filterStr}${filteredV}`);
      result = { v: filteredV, a: result.a };
    }
  }

  return result;
}

function buildClipSegment(
  ctx: BuildContext,
  clip: ResolvedClip,
  parentSpeed: number,
  parentW: number,
  parentH: number,
  spatialPwl?: SpatialPwl,
): { v: string; a: string } {
  const source = ctx.basePath ? resolve(ctx.basePath, clip.source) : clip.source;
  const idx = getOrAddInput(ctx, source);
  const seg = ctx.segmentIndex++;
  const { fps } = ctx.options;

  const effectiveSpeed = clip.speed * parentSpeed;

  // Video trim snaps to frame grid; audio uses exact times for sample-accurate cuts
  const vTrimIn = snapToFrame(clip.sourceIn, fps);
  const vTrimOut = snapToFrame(clip.sourceOut, fps);

  // Video chain: trim → setpts → fps
  let vChain = `[${idx}:v]trim=${vTrimIn}:${vTrimOut},setpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    vChain += `,setpts=PTS*${1 / effectiveSpeed}`;
  }
  vChain += `,fps=${fps}`;

  // Apply spatial scaling. Animated edges drive a per-frame `scale=eval=frame`
  // expression and intentionally bypass objectFit's pad/crop dance — the
  // sampled rect already represents the on-screen area, so we stretch the
  // source to it. Static spatial keeps the existing fit/cover/center
  // pad/crop logic.
  if (spatialPwl) {
    const wExpr = pwlToExpression(spatialPwl.w);
    const hExpr = pwlToExpression(spatialPwl.h);
    vChain += `,scale=w='${wExpr}':h='${hExpr}':eval=frame`;
  } else if (clip.objectFit) {
    const rect: SpatialRect = clip.spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
    vChain += buildObjectFitFilters(clip.objectFit, rect, clip.anchor);
  } else if (clip.spatial) {
    // Explicit spatial but no objectFit: stretch to exact dimensions
    vChain += `,scale=${clip.spatial.width}:${clip.spatial.height}`;
  }

  // Apply filters. Filter time runs in clip-output coordinates after
  // the trim+setpts reset above, so we sample over `(out - in) /
  // effectiveSpeed` seconds.
  if (clip.filters?.length) {
    const clipOutputDuration = (clip.sourceOut - clip.sourceIn) / effectiveSpeed;
    const filterStr = buildFilterChain(clip.filters, ctx, clipOutputDuration);
    if (filterStr) vChain += `,${filterStr}`;
  }

  const vLabel = `[v${seg}]`;
  ctx.filters.push(`${vChain}${vLabel}`);

  // Audio chain: uses exact source times (not frame-snapped) for sample-accurate cuts
  // Pitch-shifted speed via asetrate+aresample to match preview's playbackRate behavior
  let aChain = `[${idx}:a]atrim=${clip.sourceIn}:${clip.sourceOut},asetpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    aChain += `,asetrate=48000*${effectiveSpeed},aresample=48000`;
  }
  // The volume filter sees clip-local time after asetpts (PTS-STARTPTS
  // resets to 0). For animated volume we bake the keyframes into a
  // sample-rate-independent expression and let ffmpeg evaluate per
  // frame; static volume passes through as a literal.
  const audioDuration = (clip.sourceOut - clip.sourceIn) / effectiveSpeed;
  aChain += buildVolumeFilter(clip.volume, audioDuration, ctx.options.fps);
  const aLabel = `[a${seg}]`;
  ctx.filters.push(`${aChain}${aLabel}`);

  return { v: vLabel, a: aLabel };
}

/** Append a `,volume=…` filter when the value is non-trivial. Static
 *  values use a literal; animated values use `eval=frame` + a baked PWL
 *  expression in `t` (clip-local seconds). Returns "" when volume is
 *  effectively unity so the filter chain stays minimal. */
function buildVolumeFilter(
  volume: ResolvedClip["volume"] | undefined,
  duration: number,
  fps: number,
): string {
  if (volume == null) return "";
  if (!isKeyframed(volume)) {
    return volume === 1 ? "" : `,volume=${volume}`;
  }
  const pwl = bakePwl(volume, duration, fps);
  if (isConstant(pwl)) {
    const v = pwl.samples[0].v;
    return v === 1 ? "" : `,volume=${v}`;
  }
  return `,volume=eval=frame:volume='${pwlToExpression(pwl)}'`;
}

/**
 * Build a single audio-only resolved child into an `a` label. Same audio
 * chain as buildClipSegment, but no input on the video side — the caller
 * skips the overlay step when `v` is undefined.
 */
function buildAudioSegment(
  ctx: BuildContext,
  audio: ResolvedAudio,
  parentSpeed: number
): { a: string } {
  const source = ctx.basePath ? resolve(ctx.basePath, audio.source) : audio.source;
  const idx = getOrAddInput(ctx, source);
  const seg = ctx.segmentIndex++;
  const effectiveSpeed = audio.speed * parentSpeed;

  let aChain = `[${idx}:a]atrim=${audio.sourceIn}:${audio.sourceOut},asetpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    aChain += `,asetrate=48000*${effectiveSpeed},aresample=48000`;
  }
  const audioDuration = (audio.sourceOut - audio.sourceIn) / effectiveSpeed;
  aChain += buildVolumeFilter(audio.volume, audioDuration, ctx.options.fps);
  const aLabel = `[a${seg}]`;
  ctx.filters.push(`${aChain}${aLabel}`);

  return { a: aLabel };
}

/**
 * Build a text node into one {v, a} pair, fed by a pre-rasterized PNG
 * (static text) or PNG sequence (animated text style). The PNG(s) are
 * generated by `rasterizeAllText` before we get here; here we just hook
 * them up as ffmpeg inputs and apply spatial/objectFit/filters the same
 * way a clip would.
 */
function buildTextSegment(
  ctx: BuildContext,
  text: ResolvedText,
  parentSpeed: number,
  parentW: number,
  parentH: number,
  spatialPwl?: SpatialPwl,
): { v: string; a: string } {
  const raster = ctx.textRasters.get(text);
  if (!raster) {
    throw new Error(
      "Encountered a text node without a rasterized PNG. " +
      "Call `rasterizeAllText(timeline, dir, fps)` and pass the result " +
      "as `options.textRasters` to `buildFfmpegCommand`."
    );
  }

  const seg = ctx.segmentIndex++;
  const { fps } = ctx.options;
  const dur = snapToFrame(
    (text.timelineEnd - text.timelineStart) / parentSpeed,
    fps,
  );

  // Static PNG → loop for the node's duration. Animated sequence →
  // image2 demuxer reads `text-N-%04d.png` at the output fps.
  const inputFlags = raster.isAnimated
    ? ["-framerate", String(fps)]
    : ["-loop", "1", "-t", String(dur)];
  const idx = getOrAddInput(ctx, raster.path, inputFlags);

  // Force RGBA so the overlay step alpha-blends rather than treating
  // background pixels as opaque black.
  let vChain = `[${idx}:v]fps=${fps},format=yuva420p`;

  // Spatial scaling. Text's intrinsic size is the SVG canvas
  // (`raster.width` / `raster.height`); the spatial pass may have
  // assigned a different display rect via objectFit + content dims.
  // Animated edges drive a per-frame `scale=eval=frame` instead.
  if (spatialPwl) {
    const wExpr = pwlToExpression(spatialPwl.w);
    const hExpr = pwlToExpression(spatialPwl.h);
    vChain += `,scale=w='${wExpr}':h='${hExpr}':eval=frame`;
  } else {
    const wantsScale =
      text.spatial &&
      (Math.round(text.spatial.width) !== raster.width ||
        Math.round(text.spatial.height) !== raster.height);
    if (text.objectFit && text.spatial && wantsScale) {
      vChain += buildObjectFitFilters(text.objectFit, text.spatial, text.anchor);
    } else if (text.spatial && wantsScale) {
      vChain += `,scale=${Math.round(text.spatial.width)}:${Math.round(text.spatial.height)}`;
    }
  }

  if (text.filters?.length) {
    const textOutputDuration = (text.timelineEnd - text.timelineStart) / parentSpeed;
    const filterStr = buildFilterChain(text.filters, ctx, textOutputDuration);
    if (filterStr) vChain += `,${filterStr}`;
  }

  const vLabel = `[v${seg}]`;
  ctx.filters.push(`${vChain}${vLabel}`);

  // Text has no audio — emit silence of the segment's length so the
  // composite mixer has an `a` label to wire up.
  const aLabel = `[a${seg}]`;
  ctx.filters.push(
    `anullsrc=r=48000:cl=stereo[a${seg}_pre];[a${seg}_pre]atrim=0:${dur}${aLabel}`,
  );

  // Suppress unused-param warnings; parentW/H are kept on the signature
  // for consistency with sibling builders that need them.
  void parentW;
  void parentH;

  return { v: vLabel, a: aLabel };
}

/**
 * Generate a black video + silence segment of the given duration.
 */
function buildBlackSegment(
  ctx: BuildContext,
  dur: number
): { v: string; a: string } {
  const seg = ctx.segmentIndex++;
  const { width, height, fps } = ctx.options;
  const snappedDur = snapToFrame(dur, fps);

  const vLabel = `[v${seg}]`;
  const aLabel = `[a${seg}]`;

  ctx.filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${snappedDur},setsar=1${vLabel}`
  );
  ctx.filters.push(
    `anullsrc=r=48000:cl=stereo[a${seg}_pre];[a${seg}_pre]atrim=0:${snappedDur}${aLabel}`
  );

  return { v: vLabel, a: aLabel };
}

/**
 * Build FFmpeg filter string for objectFit scaling.
 */
function buildObjectFitFilters(objectFit: ObjectFit, spatial: SpatialRect, anchor?: SpatialAnchor): string {
  const w = Math.round(spatial.width);
  const h = Math.round(spatial.height);

  const padX = anchor?.right != null && anchor?.left == null ? "(ow-iw)" :
               anchor?.left != null && anchor?.right == null ? "0" : "(ow-iw)/2";
  const padY = anchor?.bottom != null && anchor?.top == null ? "(oh-ih)" :
               anchor?.top != null && anchor?.bottom == null ? "0" : "(oh-ih)/2";
  const cropX = anchor?.right != null && anchor?.left == null ? "(iw-ow)" :
                anchor?.left != null && anchor?.right == null ? "0" : "(iw-ow)/2";
  const cropY = anchor?.bottom != null && anchor?.top == null ? "(ih-oh)" :
                anchor?.top != null && anchor?.bottom == null ? "0" : "(ih-oh)/2";

  switch (objectFit) {
    case "center":
      return `,pad=${w}:${h}:${padX}:${padY}:color=black@0`;
    case "fit":
      return `,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:${padX}:${padY}:color=black@0`;
    case "cover":
      return `,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:${cropX}:${cropY}`;
  }
}

/**
 * Convert a filters array to an FFmpeg filter chain string. Animated
 * filter parameters use one of two paths depending on what the filter
 * supports natively:
 *
 *   - `eq` (adjust): expression strings + `eval=frame`. ffmpeg evaluates
 *     each parameter every frame, so the output is per-frame accurate
 *     with no extra filter instances.
 *   - `colorchannelmixer` (opacity), `colorbalance`, `colortemperature`:
 *     `sendcmd` ahead of the filter, emitting one stepwise command per
 *     output frame against a labelled (`@id`) instance. The filter
 *     itself only stores the t=0 value as its initial parameters.
 *
 * `duration` and `fps` are needed to bake the keyframes into PWL
 * samples; pass the segment's local duration (post-speed).
 */
function buildFilterChain(
  filters: Filter[],
  ctx: BuildContext,
  duration: number,
): string {
  const fps = ctx.options.fps;
  const prefix: string[] = [];
  const body: string[] = [];

  // Helper: turns a numeric Keyframed (or undefined) into either a
  // literal "name=value" piece, a "name='<expr>'" piece (when animated
  // and the host filter supports per-frame eval), or a sendcmd
  // registration via `addSendcmd` (when animated against a sendcmd
  // target). Returns the literal/expression piece (or "" to skip), and
  // tells the caller via `wasAnimated` whether eval=frame is needed.
  const pwlOf = (
    value: Keyframed<number> | undefined,
    defaultV: number,
  ): { piece: string; animated: boolean } => {
    if (value == null) return { piece: "", animated: false };
    if (!isKeyframed(value)) {
      return value === defaultV
        ? { piece: "", animated: false }
        : { piece: String(value), animated: false };
    }
    const pwl = bakePwl(value, duration, fps);
    if (isConstant(pwl)) {
      const v = pwl.samples[0].v;
      return v === defaultV
        ? { piece: "", animated: false }
        : { piece: String(v), animated: false };
    }
    return { piece: `'${pwlToExpression(pwl)}'`, animated: true };
  };

  // sendcmd helper: registers commands targeting `<filter>@<id>`. We
  // emit one sendcmd filter per filter instance (cheaper to scan than
  // one per parameter); commands are accumulated then concat'd.
  const sendcmdAccum = new Map<string, string[]>();
  const accumSendcmd = (target: string, commands: string) => {
    if (!commands) return;
    const list = sendcmdAccum.get(target) ?? [];
    list.push(commands);
    sendcmdAccum.set(target, list);
  };

  let nextId = 0;
  const labelFor = (kind: string) => `seam_${kind}_${nextId++}`;

  for (const f of filters) {
    switch (f.type) {
      case "adjust": {
        const pieces: string[] = [];
        let anyAnimated = false;
        const emit = (
          name: string,
          value: Keyframed<number> | undefined,
          defaultV: number,
        ) => {
          const r = pwlOf(value, defaultV);
          if (r.piece) pieces.push(`${name}=${r.piece}`);
          if (r.animated) anyAnimated = true;
        };
        emit("brightness", f.brightness, 0);
        emit("contrast", f.contrast, 1);
        emit("saturation", f.saturation, 1);
        emit("gamma", f.gamma, 1);
        if (pieces.length === 0) break;
        if (anyAnimated) pieces.push("eval=frame");
        body.push(`eq=${pieces.join(":")}`);
        break;
      }
      case "opacity": {
        // colorchannelmixer doesn't support eval=frame, so even static
        // values stay simple. Animated values become a sendcmd source
        // ahead of a labelled colorchannelmixer.
        if (!isKeyframed(f.value)) {
          body.push(`format=rgba,colorchannelmixer=aa=${f.value}`);
          break;
        }
        const pwl = bakePwl(f.value, duration, fps);
        if (isConstant(pwl)) {
          body.push(`format=rgba,colorchannelmixer=aa=${pwl.samples[0].v}`);
          break;
        }
        const id = labelFor("op");
        const target = `colorchannelmixer@${id}`;
        accumSendcmd(target, pwlToSendcmdCommands(pwl, target, "aa"));
        // Initial value is the t=0 sample.
        body.push(`format=rgba,colorchannelmixer@${id}=aa=${pwl.samples[0].v}`);
        break;
      }
      case "colorbalance": {
        const KEYS = ["rs", "gs", "bs", "rm", "gm", "bm", "rh", "gh", "bh"] as const;
        const animatedKeys = KEYS.filter((k) => isKeyframed(f[k] as never));
        const id = animatedKeys.length > 0 ? labelFor("cb") : null;
        const pieces: string[] = [];
        for (const k of KEYS) {
          const value = f[k] as Keyframed<number> | undefined;
          if (value == null) continue;
          if (isKeyframed(value)) {
            const pwl = bakePwl(value, duration, fps);
            if (isConstant(pwl)) {
              if (pwl.samples[0].v !== 0) pieces.push(`${k}=${pwl.samples[0].v}`);
            } else {
              const target = `colorbalance@${id}`;
              accumSendcmd(target, pwlToSendcmdCommands(pwl, target, k));
              pieces.push(`${k}=${pwl.samples[0].v}`);
            }
          } else if (value !== 0) {
            pieces.push(`${k}=${value}`);
          }
        }
        if (pieces.length === 0) break;
        const head = id != null ? `colorbalance@${id}` : "colorbalance";
        body.push(`${head}=${pieces.join(":")}`);
        break;
      }
      case "colortemperature": {
        if (!isKeyframed(f.temperature)) {
          body.push(`colortemperature=temperature=${f.temperature ?? 6500}`);
          break;
        }
        const pwl = bakePwl(f.temperature, duration, fps);
        if (isConstant(pwl)) {
          body.push(`colortemperature=temperature=${pwl.samples[0].v}`);
          break;
        }
        const id = labelFor("ct");
        const target = `colortemperature@${id}`;
        accumSendcmd(target, pwlToSendcmdCommands(pwl, target, "temperature"));
        body.push(`colortemperature@${id}=temperature=${pwl.samples[0].v}`);
        break;
      }
    }
  }

  // Group all sendcmd commands into one source per target, then prepend.
  for (const [, parts] of sendcmdAccum) {
    prefix.push(`sendcmd=c='${parts.join(";")}'`);
  }

  return [...prefix, ...body].filter((s) => s.length > 0).join(",");
}

/**
 * Snap a time value to the nearest frame boundary at the given fps.
 */
// All animation kinds (volume, filter values, spatial edges, text
// styles) are now handled by the renderer. The hook is preserved as the
// place to surface future regressions cleanly.
function assertNoAnimation(_children: ResolvedChild[]): void {
  // intentional no-op
}

function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

