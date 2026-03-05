import type {
  ResolvedTimeline,
  ResolvedChild,
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
  parentSpeed: number
): { v: string; a: string } {
  const totalDur = duration / parentSpeed;
  const { width, height, fps } = ctx.options;

  // Collect non-empty children as built segments with their time offsets
  const childSegments: { v: string; a: string; delay: number }[] = [];
  for (const child of children) {
    if (child.type === "empty") continue;
    const delay = child.timelineStart / parentSpeed;
    const label = buildSingleSegment(ctx, child, parentSpeed);
    childSegments.push({ ...label, delay });
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
    const resultV = `[comp${seg}]`;
    ctx.filters.push(
      `${currentV}${childV}overlay=0:0:eof_action=pass${resultV}`
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
  parentSpeed: number
): { v: string; a: string } {
  if (child.type === "clip") {
    return buildClipSegment(ctx, child, parentSpeed);
  }
  if (child.type === "empty") {
    return buildBlackSegment(ctx, (child.timelineEnd - child.timelineStart) / parentSpeed);
  }
  // Composition or overlay: recurse into children
  const compoundSpeed = child.speed * parentSpeed;
  return buildCompositeSegment(ctx, child.children, child.duration, compoundSpeed);
}

function buildClipSegment(
  ctx: BuildContext,
  clip: { source: string; sourceIn: number; sourceOut: number; speed: number },
  parentSpeed: number
): { v: string; a: string } {
  const idx = ctx.inputs.length;
  ctx.inputs.push(clip.source);
  const seg = ctx.segmentIndex++;
  const { fps } = ctx.options;

  const effectiveSpeed = clip.speed * parentSpeed;

  // Video chain: trim → setpts → fps (native resolution, no scaling/padding)
  let vChain = `[${idx}:v]trim=${clip.sourceIn}:${clip.sourceOut},setpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    vChain += `,setpts=PTS*${1 / effectiveSpeed}`;
  }
  vChain += `,fps=${fps}`;
  const vLabel = `[v${seg}]`;
  ctx.filters.push(`${vChain}${vLabel}`);

  // Audio chain: trim → asetpts → atempo
  let aChain = `[${idx}:a]atrim=${clip.sourceIn}:${clip.sourceOut},asetpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    aChain += buildAtempoChain(effectiveSpeed);
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

  const vLabel = `[v${seg}]`;
  const aLabel = `[a${seg}]`;

  ctx.filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${dur},setsar=1${vLabel}`
  );
  ctx.filters.push(
    `anullsrc=r=48000:cl=stereo[a${seg}_pre];[a${seg}_pre]atrim=0:${dur}${aLabel}`
  );

  return { v: vLabel, a: aLabel };
}

/**
 * Build an atempo filter chain. atempo only accepts values in [0.5, 100],
 * so for speeds below 0.5, chain multiple atempo filters.
 */
function buildAtempoChain(speed: number): string {
  const parts: number[] = [];
  let remaining = speed;

  if (remaining < 0.5) {
    while (remaining < 0.5) {
      parts.push(0.5);
      remaining /= 0.5;
    }
    parts.push(remaining);
  } else if (remaining > 100) {
    while (remaining > 100) {
      parts.push(100);
      remaining /= 100;
    }
    parts.push(remaining);
  } else {
    parts.push(remaining);
  }

  return parts.map((p) => `,atempo=${p}`).join("");
}
