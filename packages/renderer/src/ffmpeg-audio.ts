// Build an audio-only ffmpeg invocation from a resolved seam timeline.
//
// Why we maintain a separate audio path (instead of letting MLT do it):
// MLT chops audio into one-frame-long slices at the project framerate,
// which is fine for video but introduces audible artifacts at clip
// boundaries and during volume animation. Sample-accurate audio needs
// a continuous-time pipeline. ffmpeg's audio filters operate on
// arbitrary timestamps and ramp gain across samples without alignment
// to any frame grid, so we drive audio through ffmpeg and let MLT
// stick to video.
//
// The CLI runs three steps:
//   1. melt → silent video file (MLT does no audio at all).
//   2. ffmpeg → audio file built from this graph.
//   3. ffmpeg copy-mux: video stream from #1 + audio stream from #2.
//
// Step 1 + step 3 don't re-encode video, so the cost of the audio
// path is one extra audio-only ffmpeg pass.

import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  isKeyframed,
  type ResolvedAudio,
  type ResolvedChild,
  type ResolvedClip,
  type ResolvedTimeline,
} from "@seam/core";
import {
  bakePwl,
  isConstant,
  pwlToExpression,
} from "./animation/expr.js";

export interface AudioGraphOptions {
  basePath?: string;
  fps?: number;
  /** Absolute source paths confirmed to have no audio stream (video-only
   *  clips). Their nodes are skipped entirely — emitting `[idx:a]` for them
   *  makes ffmpeg's filtergraph "match no streams" and abort. Keyed the same
   *  way `buildAudioFromNode` resolves sources (`resolve(basePath, source)`). */
  audiolessSources?: Set<string>;
}

interface FfmpegInput {
  path: string;
}

interface BuildContext {
  inputs: FfmpegInput[];
  filters: string[];
  segmentIndex: number;
  fps: number;
  basePath: string | undefined;
  audiolessSources: Set<string> | undefined;
}

export interface FfmpegAudioCommand {
  inputs: FfmpegInput[];
  filterComplex: string;
  outputArgs: string[];
}

/** Build an ffmpeg invocation that mixes every audio-bearing node in
 *  the resolved timeline into a single output stream, written to
 *  `outputPath`. Video, text, and data nodes are ignored. */
export function buildFfmpegAudioCommand(
  timeline: ResolvedTimeline,
  outputPath: string,
  options: AudioGraphOptions = {},
): FfmpegAudioCommand {
  const ctx: BuildContext = {
    inputs: [],
    filters: [],
    segmentIndex: 0,
    fps: options.fps ?? 30,
    basePath: options.basePath,
    audiolessSources: options.audiolessSources,
  };

  const audioLabels = collectAudioLabels(ctx, timeline.children, 1);

  let outA: string;
  if (audioLabels.length === 0) {
    // Pure-silence track sized to the timeline. The mux step will
    // discard it later, but ffmpeg needs *some* output.
    const seg = ctx.segmentIndex++;
    outA = `[a${seg}]`;
    ctx.filters.push(
      `anullsrc=r=48000:cl=stereo[s${seg}_pre];[s${seg}_pre]atrim=0:${timeline.duration}${outA}`,
    );
  } else if (audioLabels.length === 1) {
    outA = audioLabels[0];
  } else {
    const seg = ctx.segmentIndex++;
    outA = `[a${seg}]`;
    // `duration=longest` keeps the output as long as the longest
    // input; `normalize=0` preserves sum semantics (no auto-divide).
    ctx.filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0${outA}`,
    );
  }

  return {
    inputs: ctx.inputs,
    filterComplex: ctx.filters.join(";\n"),
    outputArgs: [
      "-map",
      outA,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outputPath,
    ],
  };
}

function collectAudioLabels(
  ctx: BuildContext,
  children: ResolvedChild[],
  parentSpeed: number,
): string[] {
  const out: string[] = [];
  for (const child of children) {
    if (
      child.type === "empty" ||
      child.type === "data" ||
      child.type === "text" ||
      child.type === "static"
    ) continue;
    if (child.type === "composition") {
      const inner = collectAudioLabels(ctx, child.children, parentSpeed * child.speed);
      // Delay the inner composite's audio by the composition's
      // timelineStart and append to outer.
      const delay = child.timelineStart / parentSpeed;
      for (const inLabel of inner) {
        out.push(delayed(ctx, inLabel, delay));
      }
      continue;
    }
    if (child.type === "clip" || child.type === "audio") {
      const label = buildAudioFromNode(ctx, child, parentSpeed);
      if (label) {
        const delay = child.timelineStart / parentSpeed;
        out.push(delayed(ctx, label, delay));
      }
    }
  }
  return out;
}

function buildAudioFromNode(
  ctx: BuildContext,
  node: ResolvedClip | ResolvedAudio,
  parentSpeed: number,
): string | null {
  const source = ctx.basePath ? resolve(ctx.basePath, node.source) : node.source;
  // Skip inputs with no audio stream — `[idx:a]` would match no streams and
  // abort ffmpeg's whole filtergraph. Video-only clips contribute no audio.
  if (ctx.audiolessSources?.has(source)) return null;
  const idx = getOrAddInput(ctx, source);
  const seg = ctx.segmentIndex++;
  const effectiveSpeed = node.speed * parentSpeed;

  // atrim uses raw seconds (sample-accurate) — we don't snap audio to
  // the video frame grid because ffmpeg's audio filters can splice
  // mid-frame. asetpts resets the stream PTS so the volume filter
  // sees clip-local time starting at 0.
  let aChain = `[${idx}:a]atrim=${node.sourceIn}:${node.sourceOut},asetpts=PTS-STARTPTS`;
  if (effectiveSpeed !== 1) {
    // Pitch-shifted speed via asetrate+aresample matches the editor
    // preview's `playbackRate` semantics on HTMLMediaElement.
    aChain += `,asetrate=48000*${effectiveSpeed},aresample=48000`;
  }
  const audioDuration = (node.sourceOut - node.sourceIn) / effectiveSpeed;
  aChain += buildVolumeFilter(node.volume, audioDuration, ctx.fps);

  // Crossfade fades. `transition` (incoming overlap) and `transitionOut`
  // (next sibling's overlap) are in the node's container-local output
  // seconds; the stream here is in absolute output seconds (post-speed), so
  // divide by parentSpeed to match — same conversion as the `delay` below.
  // Audio sums, so both ends ramp (unlike video, where only the incoming
  // element fades and occlusion handles the rest). Linear (afade default
  // `tri` curve) to match the preview's crossfade.
  const fadeIn =
    node.transition != null && node.transition > 0
      ? Math.min(node.transition / parentSpeed, audioDuration)
      : 0;
  const fadeOut =
    node.transitionOut != null && node.transitionOut > 0
      ? Math.min(node.transitionOut / parentSpeed, audioDuration)
      : 0;
  if (fadeIn > 0) {
    aChain += `,afade=t=in:st=0:d=${afnum(fadeIn)}`;
  }
  if (fadeOut > 0) {
    aChain += `,afade=t=out:st=${afnum(audioDuration - fadeOut)}:d=${afnum(fadeOut)}`;
  }

  const aLabel = `[a${seg}]`;
  ctx.filters.push(`${aChain}${aLabel}`);
  return aLabel;
}

/** Compact decimal for ffmpeg filter args (avoids long float tails). */
function afnum(n: number): string {
  return Number(n.toFixed(6)).toString();
}

/** `,volume=…` filter when the value is non-trivial. Static unity is
 *  skipped (default). Animated values use `eval=frame` + a baked PWL
 *  expression in `t` (clip-local seconds). */
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

function delayed(ctx: BuildContext, label: string, delaySeconds: number): string {
  if (delaySeconds <= 0) return label;
  const seg = ctx.segmentIndex++;
  const delayMs = Math.round(delaySeconds * 1000);
  const out = `[da${seg}]`;
  ctx.filters.push(`${label}adelay=${delayMs}|${delayMs}${out}`);
  return out;
}

function getOrAddInput(ctx: BuildContext, path: string): number {
  for (let i = 0; i < ctx.inputs.length; i++) {
    if (ctx.inputs[i].path === path) return i;
  }
  ctx.inputs.push({ path });
  return ctx.inputs.length - 1;
}

// ── Runners ─────────────────────────────────────────────────────

export interface RunResult {
  success: boolean;
  stderr: string;
  duration: number;
}

export function checkFfmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "ffmpeg not found. Install ffmpeg and make sure it is on your PATH.",
    );
  }
}

/** Run an audio-only ffmpeg pass, optionally writing the filter graph
 *  to a sidecar file (preferred when the graph is large enough to risk
 *  the platform argv length limit). */
export async function runFfmpegAudio(
  command: FfmpegAudioCommand,
  filterScriptPath: string | undefined,
): Promise<RunResult> {
  const args: string[] = ["-y"];
  for (const inp of command.inputs) args.push("-i", inp.path);
  if (filterScriptPath) {
    await writeFile(filterScriptPath, command.filterComplex, "utf-8");
    args.push("-filter_complex_script", filterScriptPath);
  } else {
    args.push("-filter_complex", command.filterComplex);
  }
  args.push(...command.outputArgs);
  return spawnFfmpeg(args);
}

/** Final mux step: copies the video stream from `videoPath` and the
 *  audio stream from `audioPath` into one container. No re-encoding;
 *  this is just a remux, so it's fast even for long projects. */
export async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<RunResult> {
  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    outputPath,
  ];
  return spawnFfmpeg(args);
}

function spawnFfmpeg(args: string[]): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.stdout.on("data", () => {});
    child.on("error", (err) => {
      const duration = (Date.now() - start) / 1000;
      resolveRun({ success: false, stderr: `${stderr}\n${String(err)}`, duration });
    });
    child.on("close", (code) => {
      const duration = (Date.now() - start) / 1000;
      resolveRun({ success: code === 0, stderr, duration });
    });
  });
}
