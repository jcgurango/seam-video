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
} from "@seam/core";
import { isKeyframed } from "@seam/core";
import type { TextRasterMap } from "./text/textRaster.js";

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
  }[] = [];
  for (const child of children) {
    if (child.type === "empty" || child.type === "data") continue;
    const delay = snapToFrame(child.timelineStart / parentSpeed, ctx.options.fps);
    const label = buildSingleSegment(ctx, child, parentSpeed, width, height);
    const spatial = (child as any).spatial as SpatialRect | undefined;
    childSegments.push({ ...label, delay, spatial });
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
      const ox = child.spatial ? child.spatial.x : 0;
      const oy = child.spatial ? child.spatial.y : 0;
      const resultV = `[comp${seg}]`;
      ctx.filters.push(
        `${currentV}${childV}overlay=${ox}:${oy}:eof_action=pass${resultV}`
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
  parentH: number
): { v?: string; a: string } {
  if (child.type === "clip") {
    return buildClipSegment(ctx, child, parentSpeed, parentW, parentH);
  }
  if (child.type === "audio") {
    return buildAudioSegment(ctx, child, parentSpeed);
  }
  if (child.type === "empty" || child.type === "data") {
    return buildBlackSegment(ctx, snapToFrame((child.timelineEnd - child.timelineStart) / parentSpeed, ctx.options.fps));
  }
  if (child.type === "text") {
    return buildTextSegment(ctx, child, parentSpeed, parentW, parentH);
  }
  // Composition: recurse into children
  const compoundSpeed = child.speed * parentSpeed;
  const displayW = child.spatial ? child.spatial.width : parentW;
  const displayH = child.spatial ? child.spatial.height : parentH;
  const innerW = child.contentWidth ?? displayW;
  const innerH = child.contentHeight ?? displayH;
  let result = buildCompositeSegment(ctx, child.children, child.duration, compoundSpeed, innerW, innerH);

  // Scale from inner to display size if they differ
  if (innerW !== displayW || innerH !== displayH) {
    const seg = ctx.segmentIndex++;
    const scaledV = `[scaled${seg}]`;
    ctx.filters.push(
      `${result.v}scale=${Math.round(displayW)}:${Math.round(displayH)}${scaledV}`
    );
    result = { v: scaledV, a: result.a };
  }

  // Apply filters to the composite result
  if (child.filters?.length) {
    const filterStr = buildFilterChain(child.filters);
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
  parentH: number
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

  // Apply objectFit scaling
  if (clip.objectFit) {
    const rect: SpatialRect = clip.spatial ?? { x: 0, y: 0, width: parentW, height: parentH };
    vChain += buildObjectFitFilters(clip.objectFit, rect, clip.anchor);
  } else if (clip.spatial) {
    // Explicit spatial but no objectFit: stretch to exact dimensions
    vChain += `,scale=${clip.spatial.width}:${clip.spatial.height}`;
  }

  // Apply filters
  if (clip.filters?.length) {
    const filterStr = buildFilterChain(clip.filters);
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
  if (clip.volume != null && clip.volume !== 1) {
    aChain += `,volume=${clip.volume}`;
  }
  const aLabel = `[a${seg}]`;
  ctx.filters.push(`${aChain}${aLabel}`);

  return { v: vLabel, a: aLabel };
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
  if (audio.volume != null && audio.volume !== 1) {
    aChain += `,volume=${audio.volume}`;
  }
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
  const wantsScale =
    text.spatial &&
    (Math.round(text.spatial.width) !== raster.width ||
      Math.round(text.spatial.height) !== raster.height);
  if (text.objectFit && text.spatial && wantsScale) {
    vChain += buildObjectFitFilters(text.objectFit, text.spatial, text.anchor);
  } else if (text.spatial && wantsScale) {
    vChain += `,scale=${Math.round(text.spatial.width)}:${Math.round(text.spatial.height)}`;
  }

  if (text.filters?.length) {
    const filterStr = buildFilterChain(text.filters);
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
 * Convert a filters array to an FFmpeg filter chain string.
 */
function buildFilterChain(filters: Filter[]): string {
  return filters.map(f => {
    switch (f.type) {
      case "adjust": {
        const parts: string[] = [];
        if (f.brightness != null && f.brightness !== 0) parts.push(`brightness=${f.brightness}`);
        if (f.contrast != null && f.contrast !== 1) parts.push(`contrast=${f.contrast}`);
        if (f.saturation != null && f.saturation !== 1) parts.push(`saturation=${f.saturation}`);
        if (f.gamma != null && f.gamma !== 1) parts.push(`gamma=${f.gamma}`);
        return parts.length > 0 ? `eq=${parts.join(":")}` : "";
      }
      case "opacity":
        return `format=rgba,colorchannelmixer=aa=${f.value}`;
      case "colorbalance": {
        const parts: string[] = [];
        for (const key of ["rs","gs","bs","rm","gm","bm","rh","gh","bh"] as const) {
          if (f[key] != null && f[key] !== 0) parts.push(`${key}=${f[key]}`);
        }
        return parts.length > 0 ? `colorbalance=${parts.join(":")}` : "";
      }
      case "colortemperature":
        return `colortemperature=temperature=${f.temperature ?? 6500}`;
    }
  }).filter(s => s.length > 0).join(",");
}

/**
 * Snap a time value to the nearest frame boundary at the given fps.
 */
// Walk the resolved tree and bail if anything time-varying is set. The
// preview path samples per frame; the static filter graph does not.
function assertNoAnimation(children: ResolvedChild[]): void {
  const animatedFields = (
    obj: Record<string, unknown>,
    keys: readonly string[]
  ): string | null => {
    for (const k of keys) {
      if (isKeyframed(obj[k] as never)) return k;
    }
    return null;
  };
  const SPATIAL = ["top", "left", "right", "bottom", "width", "height"] as const;
  // Text styles can animate now (rasterized into a per-frame PNG sequence
  // by the renderer pre-pass). Spatial / volume / filter animation are
  // still unsupported in the static filter graph.
  const FILTER_FIELDS: Record<string, readonly string[]> = {
    adjust: ["brightness", "contrast", "saturation", "gamma"],
    opacity: ["value"],
    colorbalance: ["rs", "gs", "bs", "rm", "gm", "bm", "rh", "gh", "bh"],
    colortemperature: ["temperature"],
  };

  const walkFilters = (filters: Filter[] | undefined, label: string) => {
    if (!filters) return;
    for (const f of filters) {
      const fields = FILTER_FIELDS[f.type] ?? [];
      const hit = animatedFields(f as unknown as Record<string, unknown>, fields);
      if (hit) {
        throw new Error(
          `ffmpeg render does not yet support animated filter values (got ${f.type}.${hit} on ${label}). Bake the value or use the editor preview.`
        );
      }
    }
  };

  const walk = (node: ResolvedChild) => {
    if (node.type === "empty" || node.type === "data") return;
    const inp = (node as { spatialInput?: Record<string, unknown> }).spatialInput;
    if (inp) {
      const hit = animatedFields(inp, SPATIAL);
      if (hit) {
        throw new Error(
          `ffmpeg render does not yet support animated spatial properties (got ${hit} on a ${node.type}). Use the editor preview.`
        );
      }
    }
    if (node.type === "clip" || node.type === "audio") {
      if (isKeyframed(node.volume as never)) {
        throw new Error(
          `ffmpeg render does not yet support animated 'volume' (on a ${node.type}). Use the editor preview.`
        );
      }
    }
    if (node.type === "clip" || node.type === "composition" || node.type === "text") {
      walkFilters(node.filters, node.type);
    }
    if (node.type === "composition") {
      for (const c of node.children) walk(c);
    }
  };

  for (const c of children) walk(c);
}

function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

