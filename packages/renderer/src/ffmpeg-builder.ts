import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
  SpatialRect,
  SpatialAnchor,
  ObjectFit,
} from "@seam/core";

export interface FfmpegCommand {
  inputs: string[];
  filterComplex: string;
  outputArgs: string[];
}

export interface FfmpegOptions {
  width?: number;
  height?: number;
  fps?: number;
}

interface BuildContext {
  inputs: string[];
  filters: string[];
  segmentIndex: number;
  options: Required<FfmpegOptions>;
}

export function buildFfmpegCommand(
  timeline: ResolvedTimeline,
  outputPath: string,
  options: FfmpegOptions = {}
): FfmpegCommand {
  const opts: Required<FfmpegOptions> = {
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
  };

  const ctx: BuildContext = {
    inputs: [],
    filters: [],
    segmentIndex: 0,
    options: opts,
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
 * and overlaying each child at its timelineStart offset. Works for both
 * sequential compositions and stacked overlays.
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

  // Collect non-empty children as built segments with their time offsets
  const childSegments: { v: string; a: string; delay: number; spatial?: SpatialRect }[] = [];
  for (const child of children) {
    if (child.type === "empty") continue;
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
      const delayedV = `[dv${seg}]`;
      ctx.filters.push(
        `${childV}format=yuva420p,tpad=start_duration=${child.delay}:color=black@0${delayedV}`
      );
      childV = delayedV;

      const delayMs = Math.round(child.delay * 1000);
      const delayedA = `[da${seg}]`;
      ctx.filters.push(
        `${childA}adelay=${delayMs}|${delayMs}${delayedA}`
      );
      childA = delayedA;
    }

    // Overlay child on top of current result
    const ox = child.spatial ? child.spatial.x : 0;
    const oy = child.spatial ? child.spatial.y : 0;
    const resultV = `[comp${seg}]`;
    ctx.filters.push(
      `${currentV}${childV}overlay=${ox}:${oy}:eof_action=pass${resultV}`
    );
    currentV = resultV;
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
 * Build a single resolved child into one {v, a} label pair.
 */
function buildSingleSegment(
  ctx: BuildContext,
  child: ResolvedChild,
  parentSpeed: number,
  parentW: number,
  parentH: number
): { v: string; a: string } {
  if (child.type === "clip") {
    return buildClipSegment(ctx, child, parentSpeed, parentW, parentH);
  }
  if (child.type === "empty") {
    return buildBlackSegment(ctx, snapToFrame((child.timelineEnd - child.timelineStart) / parentSpeed, ctx.options.fps));
  }
  // Composition or overlay: recurse into children
  const compoundSpeed = child.speed * parentSpeed;
  const displayW = child.spatial ? child.spatial.width : parentW;
  const displayH = child.spatial ? child.spatial.height : parentH;
  const innerW = child.contentWidth ?? displayW;
  const innerH = child.contentHeight ?? displayH;
  const result = buildCompositeSegment(ctx, child.children, child.duration, compoundSpeed, innerW, innerH);

  // Scale from inner to display size if they differ
  if (innerW !== displayW || innerH !== displayH) {
    const seg = ctx.segmentIndex++;
    const scaledV = `[scaled${seg}]`;
    ctx.filters.push(
      `${result.v}scale=${Math.round(displayW)}:${Math.round(displayH)}${scaledV}`
    );
    return { v: scaledV, a: result.a };
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
  const idx = ctx.inputs.length;
  ctx.inputs.push(clip.source);
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

  const vLabel = `[v${seg}]`;
  ctx.filters.push(`${vChain}${vLabel}`);

  // Audio chain: uses exact source times (not frame-snapped) for sample-accurate cuts
  // Pitch-shifted speed via asetrate+aresample to match preview's playbackRate behavior
  let aChain = `[${idx}:a]atrim=${clip.sourceIn}:${clip.sourceOut},asetpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    aChain += `,asetrate=48000*${effectiveSpeed},aresample=48000`;
  }
  const aLabel = `[a${seg}]`;
  ctx.filters.push(`${aChain}${aLabel}`);

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
 * Snap a time value to the nearest frame boundary at the given fps.
 */
function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

