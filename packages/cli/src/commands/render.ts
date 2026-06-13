import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  compileSeamFile,
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";
import type { ResolvedChild } from "@seam/core";
import {
  buildFfmpegAudioCommand,
  buildMeltArgs,
  writeMeltProfile,
  buildMltDocument,
  checkFfmpeg,
  checkFfprobe,
  checkMelt,
  prerenderCompositionMlts,
  probeIntrinsicSizes,
  rasterizeAllGraphics,
  rasterizeAllText,
  renderWithMelt,
  runFfmpegAudio,
  type OnRasterProgress,
  type RasterProgress,
} from "@seam/renderer";

/** A small TTY-aware progress line for the otherwise-silent text/graphic
 *  rasterization passes. On a TTY it redraws one carriage-return line and
 *  clears it when done; piped/non-TTY, it prints one line per node. The
 *  header + summary only appear if the pass actually has nodes. */
function rasterReporter(noun: string): {
  onProgress: OnRasterProgress;
  done: () => void;
} {
  const tty = process.stderr.isTTY === true;
  let started = false;
  let total = 0;
  let frames = 0;
  let lastIndex = -1;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  return {
    onProgress(p: RasterProgress) {
      total = p.total;
      frames++;
      if (!started) {
        started = true;
        process.stderr.write(`Generating ${plural(total, noun)}…\n`);
      }
      if (tty) {
        const frag = p.animated ? ` · frame ${p.frame}/${p.frameCount}` : "";
        process.stderr.write(`\r  ${p.index + 1}/${total}${frag}\x1b[K`);
      } else if (p.index !== lastIndex) {
        lastIndex = p.index;
        const frag = p.animated ? ` (${p.frameCount} frames)` : "";
        process.stderr.write(`  ${p.index + 1}/${total}${frag}\n`);
      }
    },
    done() {
      if (!started) return;
      const summary = `  done · ${plural(total, noun)}, ${plural(frames, "frame")}`;
      if (tty) process.stderr.write(`\r${summary}\x1b[K\n`);
      else process.stderr.write(`${summary}\n`);
    },
  };
}

/** Collect every clip/static `source` in the resolved tree (recursing
 *  into compositions). Used to probe media dimensions up front so the MLT
 *  builder can honor objectFit cover/center. */
function collectMediaSources(children: ResolvedChild[], out: Set<string>): void {
  for (const child of children) {
    if (child.type === "clip" || child.type === "static") {
      out.add(child.source);
    } else if (child.type === "composition") {
      collectMediaSources(child.children, out);
    }
  }
}

interface RenderOptions {
  output?: string;
  fps?: string;
  width?: string;
  height?: string;
  dryRun?: boolean;
  proxy?: string[];
}

/** Parse `--proxy ORIGINAL:REPLACEMENT` strings (split on the first ':')
 *  into an exact-match source→replacement map. */
function parseProxies(specs: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const spec of specs ?? []) {
    const sep = spec.indexOf(":");
    if (sep <= 0 || sep === spec.length - 1) {
      throw new Error(
        `Invalid --proxy "${spec}": expected ORIGINAL:REPLACEMENT (split on the first ':').`,
      );
    }
    map.set(spec.slice(0, sep), spec.slice(sep + 1));
  }
  return map;
}

/** Rewrite clip/static/audio `source` fields that exactly equal a proxy
 *  key, recursing into compositions. Verbatim match — no path resolution.
 *  Mutates the resolved tree in place (our local copy). */
function applyProxies(children: ResolvedChild[], proxies: Map<string, string>): void {
  if (proxies.size === 0) return;
  for (const child of children) {
    if (child.type === "clip" || child.type === "static" || child.type === "audio") {
      const replacement = proxies.get(child.source);
      if (replacement != null) child.source = replacement;
    } else if (child.type === "composition") {
      applyProxies(child.children, proxies);
    }
  }
}

/** Quote an argv element for safe display as a shell command. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function renderCommand(file: string, options: RenderOptions) {
  const filePath = resolve(file);
  const fps = options.fps ? parseInt(options.fps, 10) : 30;
  const dryRun = !!options.dryRun;

  let proxies: Map<string, string>;
  try {
    proxies = parseProxies(options.proxy);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!dryRun) {
    checkFfmpeg();
    checkFfprobe();
    checkMelt();
  }

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
  const temporal = resolveComposition(compiled);

  // Root contentWidth/Height must be pixel numbers (resolveSpatial will
  // reject a root percentage anyway). The Length type is widened on
  // the resolved tree to carry authored percent strings through nested
  // compositions; cast to number at the root.
  const width = options.width
    ? parseInt(options.width, 10)
    : ((temporal.contentWidth as number | undefined) ?? DEFAULT_CANVAS_WIDTH);
  const height = options.height
    ? parseInt(options.height, 10)
    : ((temporal.contentHeight as number | undefined) ?? DEFAULT_CANVAS_HEIGHT);
  const timeline = resolveSpatial(temporal, width, height);
  // Swap source paths before anything reads them (probe, audio, raster,
  // MLT build all consume `timeline`'s sources).
  applyProxies(timeline.children, proxies);
  const outputPath = options.output ?? filePath.replace(/\.seam$/, ".mp4");
  const basePath = dirname(filePath);

  // Sidecar dir holds the rasterized text PNGs, the pre-rendered
  // audio mix, and the MLT XML we hand to melt. Lives next to the
  // .seam so paths inside the XML are easy to inspect; cleaned up
  // after success unless --dry-run is set.
  const assetsDir = `${filePath}-rendered`;
  await mkdir(assetsDir, { recursive: true });
  const scriptPath = join(assetsDir, "project.mlt");
  const audioPath = join(assetsDir, "audio.m4a");
  const audioFilterScript = join(assetsDir, "audio-filter.txt");

  try {
    // Rasterize text nodes to PNGs in the assets dir before building
    // the MLT document — the document references each PNG by absolute
    // path, so the files have to exist when melt parses the project.
    const textDir = join(assetsDir, "text");
    const textReporter = rasterReporter("text node");
    const textRasters = await rasterizeAllText(
      timeline,
      textDir,
      fps,
      textReporter.onProgress,
    );
    textReporter.done();
    const graphicDir = join(assetsDir, "graphic");
    const graphicReporter = rasterReporter("graphic");
    const graphicRasters = await rasterizeAllGraphics(
      timeline,
      graphicDir,
      fps,
      basePath,
      graphicReporter.onProgress,
    );
    graphicReporter.done();

    // Pre-render audio with ffmpeg first. MLT slices audio along the
    // video frame grid which produces audible artifacts at clip
    // boundaries and when volume animates; ffmpeg's audio filters
    // operate on continuous time, so the mix lands sample-accurate.
    // The resulting file is then referenced by the MLT graph as a
    // single producer that spans the timeline.
    const audioCommand = buildFfmpegAudioCommand(timeline, audioPath, {
      basePath,
      fps,
    });

    // Probe each clip/static's display dimensions so the builder can emit
    // the correct natural rect for objectFit cover/center (it otherwise
    // falls back to the parent box and qtblend stretches the source).
    const sources = new Set<string>();
    collectMediaSources(timeline.children, sources);
    const intrinsicSizes = dryRun
      ? undefined
      : await probeIntrinsicSizes(sources, basePath);

    // Pre-render complex nested compositions (own spatial / non-fit
    // objectFit / filters) to sidecar sub-`.mlt` files. The builder then
    // composites each as a single layer instead of flattening its children
    // and dropping the wrapper. Reuses the text/graphic rasters + probed
    // dims for the nested content.
    const compDir = join(assetsDir, "comp");
    await mkdir(compDir, { recursive: true });
    const { compositionMlts, limitations: compLimits } =
      await prerenderCompositionMlts(timeline, compDir, fps, {
        basePath,
        textRasters,
        graphicRasters,
        intrinsicSizes,
      });

    const { xml, limitations: buildLimits } = buildMltDocument(timeline, {
      fps,
      width,
      height,
      basePath,
      textRasters,
      graphicRasters,
      audioFile: audioPath,
      intrinsicSizes,
      compositionMlts,
    });
    const limitations = [...compLimits, ...buildLimits];

    // Always surface translation limitations. They're not fatal —
    // most just mean a feature was silently dropped — but the user
    // needs to know which fields didn't round-trip.
    if (limitations.length > 0) {
      console.warn(`MLT translation notes (${limitations.length}):`);
      const grouped = new Map<string, number>();
      for (const lim of limitations) {
        const key = `${lim.node}.${lim.field}: ${lim.detail}`;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
      for (const [key, count] of grouped) {
        console.warn(`  ${count > 1 ? `[${count}×] ` : ""}${key}`);
      }
    }

    // Pass canvas dims to melt so the output matches the seam doc's
    // declared size — without these flags, MLT's first producer wins
    // (a portrait clip would otherwise pull the whole render
    // portrait, ignoring the project's own contentWidth/Height).
    const meltOpts = { scriptPath, width, height, fps };

    if (dryRun) {
      await writeFile(scriptPath, xml, "utf-8");
      await writeMeltProfile(meltOpts);
      const meltArgs = buildMeltArgs(scriptPath, outputPath, meltOpts);
      console.log("# dry run — would invoke:");
      console.log("# 1) ffmpeg (audio):");
      console.log(
        [
          "ffmpeg",
          "-y",
          ...audioCommand.inputs.flatMap((i) => ["-i", i.path]),
          "-filter_complex_script",
          audioFilterScript,
          ...audioCommand.outputArgs,
        ]
          .map(shellQuote)
          .join(" "),
      );
      console.log("# 2) melt (video + text + pre-rendered audio):");
      console.log(["melt", ...meltArgs].map(shellQuote).join(" "));
      console.log(`\n# assets left in: ${assetsDir}`);
      return;
    }

    console.log("Rendering audio mix...");
    const audioResult = await runFfmpegAudio(audioCommand, audioFilterScript);
    if (!audioResult.success) {
      console.error(`\nffmpeg audio pass failed (exited after ${audioResult.duration.toFixed(1)}s).`);
      process.exit(1);
    }

    console.log(`Rendering to ${outputPath}...`);
    const renderResult = await renderWithMelt(xml, outputPath, meltOpts);

    if (renderResult.success) {
      console.log(
        `Done in ${(audioResult.duration + renderResult.duration).toFixed(1)}s → ${outputPath}`,
      );
    } else {
      console.error(`\nmelt failed (exited after ${renderResult.duration.toFixed(1)}s).`);
      process.exit(1);
    }
  } finally {
    if (!dryRun) {
      try {
        await rm(assetsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; if the dir doesn't exist anymore that's fine.
      }
    }
  }
}
