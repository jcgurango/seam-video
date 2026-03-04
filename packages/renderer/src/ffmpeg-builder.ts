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

  const segmentLabels = buildSegments(ctx, timeline.children, 1);

  // Concat all segments
  if (segmentLabels.length === 0) {
    // Degenerate: empty timeline
    const dur = Math.max(timeline.duration, 0.001);
    ctx.filters.push(
      `color=c=black:s=${opts.width}x${opts.height}:r=${opts.fps}:d=${dur}[outv]`,
      `anullsrc=r=48000:cl=stereo[outa_pre]`,
      `[outa_pre]atrim=0:${dur}[outa]`
    );
  } else if (segmentLabels.length === 1) {
    const { v, a } = segmentLabels[0];
    ctx.filters.push(`${v}copy[outv]`, `${a}acopy[outa]`);
  } else {
    const concatIn = segmentLabels.map(({ v, a }) => `${v}${a}`).join("");
    ctx.filters.push(
      `${concatIn}concat=n=${segmentLabels.length}:v=1:a=1[outv][outa]`
    );
  }

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

function buildSegments(
  ctx: BuildContext,
  children: ResolvedChild[],
  parentSpeed: number
): { v: string; a: string }[] {
  const labels: { v: string; a: string }[] = [];

  for (const child of children) {
    if (child.type === "clip") {
      const label = buildClipSegment(ctx, child, parentSpeed);
      labels.push(label);
    } else if (child.type === "empty") {
      const label = buildEmptySegment(ctx, child, parentSpeed);
      labels.push(label);
    } else {
      // Composition: recurse with compounded speed
      const compoundSpeed = child.speed * parentSpeed;
      const innerLabels = buildSegments(ctx, child.children, compoundSpeed);
      labels.push(...innerLabels);
    }
  }

  return labels;
}

function buildClipSegment(
  ctx: BuildContext,
  clip: { source: string; sourceIn: number; sourceOut: number; speed: number },
  parentSpeed: number
): { v: string; a: string } {
  const idx = ctx.inputs.length;
  ctx.inputs.push(clip.source);
  const seg = ctx.segmentIndex++;
  const { width, height, fps } = ctx.options;

  const effectiveSpeed = clip.speed * parentSpeed;

  // Video chain: trim → setpts → scale → fps
  let vChain = `[${idx}:v]trim=${clip.sourceIn}:${clip.sourceOut},setpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    vChain += `,setpts=PTS*${1 / effectiveSpeed}`;
  }
  vChain += `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
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

function buildEmptySegment(
  ctx: BuildContext,
  empty: { timelineStart: number; timelineEnd: number },
  parentSpeed: number
): { v: string; a: string } {
  const seg = ctx.segmentIndex++;
  const { width, height, fps } = ctx.options;
  const dur = (empty.timelineEnd - empty.timelineStart) / parentSpeed;

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
