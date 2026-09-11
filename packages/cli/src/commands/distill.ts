import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  FilePathTarget,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { parseSeamFile } from "@seam/core";

export interface DistillOptions {
  output?: string;
  mediaDir?: string;
}

interface ClipNode {
  type: "clip";
  source: string;
  in?: number;
  out?: number;
  [key: string]: unknown;
}

/** Walk the raw (authored) document JSON collecting every clip node —
 *  children + attachments recursively, plus bin entry bodies. Graphic nodes
 *  are treated as leaves (their embedded clip defs stay untouched). */
function collectClips(node: unknown, out: ClipNode[]) {
  if (node == null || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "clip" && typeof n.source === "string") {
    out.push(n as unknown as ClipNode);
    return;
  }
  if (n.type === "graphic") return;
  for (const field of ["children", "attachments"]) {
    const arr = n[field];
    if (Array.isArray(arr)) for (const child of arr) collectClips(child, out);
  }
  if (n.bin && typeof n.bin === "object") {
    for (const entry of Object.values(n.bin)) collectClips(entry, out);
  }
}

/** Attachments can anchor to a clip in its *source* timebase
 *  (`timeSource: "source"`, `anchorPoint` in source seconds). Trimming shifts
 *  a clip's source timebase back by its keyframe lead-in, so any source-mode
 *  anchor targeting a rewritten clip's id must shift by the same amount. */
function shiftSourceAnchors(node: unknown, idShifts: Map<string, number>) {
  if (node == null || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "graphic") return;
  for (const field of ["start", "end"]) {
    const spec = n[field] as Record<string, unknown> | undefined;
    if (
      spec != null &&
      typeof spec === "object" &&
      typeof spec.anchor === "string" &&
      spec.timeSource === "source" &&
      idShifts.has(spec.anchor)
    ) {
      spec.anchorPoint =
        ((spec.anchorPoint as number | undefined) ?? 0) - idShifts.get(spec.anchor)!;
    }
  }
  for (const field of ["children", "attachments"]) {
    const arr = n[field];
    if (Array.isArray(arr)) for (const child of arr) shiftSourceAnchors(child, idShifts);
  }
  if (n.bin && typeof n.bin === "object") {
    for (const entry of Object.values(n.bin)) shiftSourceAnchors(entry, idShifts);
  }
}

function outputFormatFor(ext: string) {
  switch (ext.toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return new Mp4OutputFormat();
    case ".mov":
    case ".qt":
      return new MovOutputFormat();
    case ".mkv":
      return new MkvOutputFormat();
    case ".webm":
      return new WebMOutputFormat();
    default:
      return null;
  }
}

/** `[source-with-unsupported-characters-removed]-[in-frame]-[out-frame]` */
function distilledName(source: string, inFrame: number, outFrame: number, ext: string) {
  const base = source.slice(0, source.length - extname(source).length);
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, "");
  return `${clean}-${inFrame}-${outFrame}${ext}`;
}

const PCM_BYTES: Record<string, number> = {
  "pcm-s16": 2, "pcm-s16be": 2, "pcm-s24": 3, "pcm-s24be": 3,
  "pcm-s32": 4, "pcm-s32be": 4, "pcm-f32": 4, "pcm-f32be": 4,
  "pcm-f64": 8, "pcm-f64be": 8, "pcm-u8": 1, "pcm-s8": 1,
};

const EPS = 1e-6;

interface TrimResult {
  keyTime: number;
  videoPackets: number;
  leadingDropped: number;
}

/** Lossless keyframe-snapped trim: copies encoded packets of the primary
 *  video + audio track covering [startTime, endTime] into targetPath.
 *  Video is GOP-complete: starts at the keyframe at/before startTime and
 *  runs through the first keyframe at/after endTime (plus that keyframe's
 *  open-GOP leading B-frames), so every frame in the window decodes. */
async function trimFile(
  input: Input,
  targetPath: string,
  startTime: number,
  endTime: number,
  copyPackets: boolean,
): Promise<TrimResult> {
  const videoTrack = (await input.getPrimaryVideoTrack())!;
  const vSink = new EncodedPacketSink(videoTrack);
  let keyPacket = await vSink.getKeyPacket(startTime, { verifyKeyPackets: true });
  let keyTime: number;
  if (keyPacket) {
    keyTime = keyPacket.timestamp;
  } else {
    // No keyframe at/before startTime — e.g. the file opens with leading
    // B-frames whose pts precede the first keyframe's. Copy from the
    // decode-order start with no offset: the whole reference chain is
    // present, so nothing needs dropping and timing is preserved verbatim.
    keyPacket = await vSink.getFirstPacket({ verifyKeyPackets: true });
    if (!keyPacket) throw new Error("no video packets");
    keyTime = 0;
  }

  if (!copyPackets) return { keyTime, videoPackets: 0, leadingDropped: 0 };

  const format = outputFormatFor(extname(targetPath));
  if (!format) throw new Error(`unsupported container: ${extname(targetPath)}`);
  const output = new Output({ format, target: new FilePathTarget(targetPath) });

  const vSource = new EncodedVideoPacketSource(videoTrack.codec!);
  output.addVideoTrack(vSource, { rotation: await videoTrack.getRotation() });

  const audioTrack = await input.getPrimaryAudioTrack();
  const aSource = audioTrack?.codec
    ? new EncodedAudioPacketSource(audioTrack.codec)
    : null;
  if (audioTrack && aSource) output.addAudioTrack(aSource);

  await output.start();

  const vMeta = { decoderConfig: (await videoTrack.getDecoderConfig()) ?? undefined };
  let videoPackets = 0;
  let leadingDropped = 0;
  // The keyframe that closes the window: first key packet with pts >= endTime.
  // We copy through it plus its own leading B-frames (decode-order followers
  // with pts before it) so no kept frame lacks a reference.
  let closingKeyTime: number | null = null;
  for await (const packet of vSink.packets(keyPacket, undefined, { verifyKeyPackets: true })) {
    if (closingKeyTime !== null && packet.timestamp >= closingKeyTime) break;
    if (closingKeyTime === null && packet.type === "key" && packet.timestamp >= endTime - EPS && packet.timestamp > keyTime) {
      closingKeyTime = packet.timestamp;
    }
    const t = packet.timestamp - keyTime;
    if (t < 0) {
      leadingDropped++; // open-GOP leading B of the starting keyframe
      continue;
    }
    await vSource.add(packet.clone({ timestamp: t }), vMeta);
    videoPackets++;
  }
  vSource.close();

  if (audioTrack && aSource) {
    const aSink = new EncodedPacketSink(audioTrack);
    const aMeta = { decoderConfig: (await audioTrack.getDecoderConfig()) ?? undefined };
    const pcmBytes = PCM_BYTES[audioTrack.codec ?? ""];
    const sampleRate = await audioTrack.getSampleRate();
    const channels = await audioTrack.getNumberOfChannels();
    const startPacket =
      (await aSink.getPacket(keyTime)) ?? (await aSink.getFirstPacket());
    for await (const packet of aSink.packets(startPacket ?? undefined)) {
      if (packet.timestamp >= endTime - EPS) break;
      let t = packet.timestamp - keyTime;
      if (t < 0) {
        const overlap = packet.timestamp + packet.duration - keyTime;
        if (overlap <= 0) continue; // wholly before the window
        if (pcmBytes) {
          // PCM: byte-slice the straddling packet so audio starts exactly at
          // the keyframe instead of one packet-duration late.
          const frameBytes = pcmBytes * channels;
          const skipFrames = Math.round((keyTime - packet.timestamp) * sampleRate);
          const sliced = packet.data.subarray(skipFrames * frameBytes);
          await aSource.add(
            new EncodedPacket(sliced, "key", 0, overlap),
            aMeta,
          );
          continue;
        }
        continue; // compressed straddler can't be sliced; ≤1 packet gap
      }
      await aSource.add(packet.clone({ timestamp: t }), aMeta);
    }
    aSource.close();
  }

  await output.finalize();
  return { keyTime, videoPackets, leadingDropped };
}

export async function distillCommand(file: string, options: DistillOptions) {
  const seamPath = resolve(file);
  const seamDir = dirname(seamPath);
  const outSeamPath = options.output
    ? resolve(options.output)
    : join(seamDir, `${basename(seamPath, extname(seamPath))}-distilled.seam`);
  const mediaDir = options.mediaDir
    ? resolve(options.mediaDir)
    : join(dirname(outSeamPath), "distilled-media");

  const raw = readFileSync(seamPath, "utf-8");
  const parsed = parseSeamFile(raw);
  if (!parsed.success) {
    console.error("Validation errors:");
    for (const err of parsed.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  // Rewrite the raw JSON (not the Zod output) so untouched parts of the
  // document survive verbatim, without defaults materializing.
  const doc = JSON.parse(raw);
  const clips: ClipNode[] = [];
  collectClips(doc, clips);

  mkdirSync(mediaDir, { recursive: true });

  const inputs = new Map<string, Input>();
  const openInput = (path: string) => {
    let input = inputs.get(path);
    if (!input) {
      input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
      inputs.set(path, input);
    }
    return input;
  };

  let trimmed = 0;
  let reused = 0;
  let untouched = 0;
  const failures: string[] = [];
  const idShifts = new Map<string, number>();

  for (const clip of clips) {
    if (clip.in == null && clip.out == null) {
      untouched++; // whole file is needed; nothing to distill
      continue;
    }
    const ext = extname(clip.source);
    if (!outputFormatFor(ext)) {
      console.warn(`skip (unsupported container): ${clip.source}`);
      untouched++;
      continue;
    }
    const absSource = isAbsolute(clip.source)
      ? clip.source
      : resolve(seamDir, clip.source);
    if (!existsSync(absSource)) {
      console.warn(`skip (missing file): ${clip.source}`);
      untouched++;
      continue;
    }

    try {
      const input = openInput(absSource);
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        console.warn(`skip (no video track): ${clip.source}`);
        untouched++;
        continue;
      }
      const stats = await videoTrack.computePacketStats(100);
      const fps = stats.averagePacketRate;
      const startTime = clip.in ?? 0;
      const endTime = clip.out ?? (await videoTrack.computeDuration());

      const name = distilledName(
        clip.source,
        Math.round(startTime * fps),
        Math.round(endTime * fps),
        ext,
      );
      const targetPath = join(mediaDir, name);
      const exists = existsSync(targetPath);
      const result = await trimFile(input, targetPath, startTime, endTime, !exists);
      if (exists) reused++;
      else trimmed++;

      clip.source = relative(dirname(outSeamPath), targetPath).replace(/\\/g, "/");
      if (clip.in != null) clip.in = startTime - result.keyTime;
      else if (result.keyTime > 0) clip.in = startTime - result.keyTime;
      if (clip.out != null) clip.out = endTime - result.keyTime;
      if (typeof clip.id === "string" && result.keyTime !== 0) {
        idShifts.set(clip.id, result.keyTime);
      }

      const action = exists ? "reused" : "trimmed";
      console.log(
        `${action}: ${name}  [${startTime.toFixed(3)}..${endTime.toFixed(3)}]` +
          ` key@${result.keyTime.toFixed(3)} lead-in ${(startTime - result.keyTime).toFixed(3)}s`,
      );
    } catch (err) {
      failures.push(clip.source);
      console.error(`FAILED ${clip.source}: ${err instanceof Error ? err.message : err}`);
      untouched++;
    }
  }

  if (idShifts.size > 0) shiftSourceAnchors(doc, idShifts);

  writeFileSync(outSeamPath, JSON.stringify(doc, null, 2) + "\n");

  console.log("---");
  console.log(`wrote ${outSeamPath}`);
  console.log(
    `${trimmed} trimmed, ${reused} reused (already distilled), ${untouched} untouched` +
      (failures.length ? `, ${failures.length} FAILED` : ""),
  );
  if (failures.length) process.exit(1);
}
