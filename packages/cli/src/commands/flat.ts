import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSeamFile,
  parseSeamFile,
  resolveComposition,
  sampleVolume,
} from "@seam/core";
import type { Keyframed, ResolvedChild } from "@seam/core";

export interface FlatOptions {
  output?: string;
  pretty?: boolean;
}

interface FlatSourceEntry {
  type: "clip" | "audio" | "static";
  source: string;
  in: number;
  out: number;
  start: number;
  end: number;
  /** Absolute linear gain: own volume × every enclosing composition's volume
   *  × the root volume. Keyframed contributors sampled at the entry's
   *  midpoint. Absent on static (no audio). */
  volume?: number;
}

/** An enclosing composition's volume, positioned in absolute output time so
 *  it can be sampled the way the audio mixers do (comp-output-local time
 *  against the comp's output duration). */
interface VolumeEnv {
  volume: Keyframed<number | string>;
  startAbs: number;
  duration: number;
}

function volumeAt(
  own: Keyframed<number | string> | undefined,
  envs: VolumeEnv[],
  mid: number,
  start: number,
  end: number,
): number {
  let v = own == null ? 1 : sampleVolume(own, mid - start, end - start);
  for (const env of envs) {
    v *= sampleVolume(env.volume, mid - env.startAbs, env.duration);
  }
  return v;
}

/** Like core's flattenResolved, but carries the enclosing compositions'
 *  volume envelopes down so each leaf gets an absolute gain. */
function collect(
  children: ResolvedChild[],
  parentOffset: number,
  parentSpeed: number,
  envs: VolumeEnv[],
  out: FlatSourceEntry[],
) {
  for (const child of children) {
    const start = parentOffset + child.timelineStart / parentSpeed;
    const end = parentOffset + child.timelineEnd / parentSpeed;

    if (child.type === "clip" || child.type === "audio") {
      out.push({
        type: child.type,
        source: child.source,
        in: child.sourceIn,
        out: child.sourceOut,
        start,
        end,
        volume: volumeAt(child.volume, envs, (start + end) / 2, start, end),
      });
    } else if (child.type === "static") {
      // Static has no trim window — the frozen frame time stands in for both.
      out.push({
        type: "static",
        source: child.source,
        in: child.sourceTime,
        out: child.sourceTime,
        start,
        end,
      });
    } else if (child.type === "composition") {
      const innerEnvs = child.volume
        ? [...envs, { volume: child.volume, startAbs: start, duration: end - start }]
        : envs;
      collect(child.children, start, child.speed * parentSpeed, innerEnvs, out);
    }
  }
}

export async function flatCommand(file: string, options: FlatOptions) {
  const filePath = resolve(file);

  const json = readFileSync(filePath, "utf-8");
  const result = parseSeamFile(json);
  if (!result.success) {
    console.error("Validation errors:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const { doc: compiled, errors: compileErrors } = compileSeamFile(result.data);
  if (compileErrors.length > 0) {
    console.error("Compile errors:");
    for (const err of compileErrors) {
      console.error(`  - ${err.source}: ${err.message}`);
    }
    process.exit(1);
  }

  const timeline = resolveComposition(compiled);
  const rootEnvs: VolumeEnv[] = timeline.volume
    ? [{ volume: timeline.volume, startAbs: 0, duration: timeline.duration }]
    : [];

  const entries: FlatSourceEntry[] = [];
  collect(timeline.children, 0, 1, rootEnvs, entries);

  // Attachments resolve after all children, so restore chronological order.
  entries.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = options.pretty !== false
    ? JSON.stringify(entries, null, 2)
    : JSON.stringify(entries);

  if (options.output) {
    writeFileSync(resolve(options.output), out);
  } else {
    process.stdout.write(out + "\n");
  }
}
