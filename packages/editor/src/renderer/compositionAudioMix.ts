// Offline mixer that renders a composition's audio into one mono WAV, for
// transcription. Compositions are otherwise a no-op for the transcribe job:
// here we resolve the composition as its own root, flatten it to leaves, and
// schedule every clip/audio leaf into an OfflineAudioContext at its resolved
// timeline position — honouring per-leaf speed, volume (static or keyframed)
// and crossfade fades, mirroring the preview's AudioScheduler.
//
// Because `resolveComposition` treats the passed node as the root, it ignores
// the comp's own `in`/`out`/`speed` window (those only matter when it's a
// child). So the mix covers the composition's *inner* timeline starting at 0,
// which means whisper timestamps over this WAV ARE the composition's
// source-time directly — the caller anchors transcript data nodes to the comp
// id with `timeSource: "source"` and `anchorPoint = segTime` (no offset).

import {
  compileSeamFile,
  resolveComposition,
  flattenResolved,
  sampleVolume,
  isKeyframed,
  type BinEntry,
  type Composition,
  type FlatLeaf,
} from "@seam/core";
import { decodeMonoRange, encodeWavMono16, type MonoRange } from "./audioExtract.js";

/** A clip/audio leaf — the audio-bearing subset of FlatLeaf. */
type AudioLeaf = Extract<FlatLeaf, { type: "clip" | "audio" }>;

export interface MixCompositionOptions {
  /** Include the composition's top-level `attachments` array in the mix.
   *  When false, only the sequential `children` contribute audio. (Nested
   *  compositions are always resolved in full — the choice only gates the
   *  selected composition's own attachments.) */
  includeAttachments: boolean;
  /** The enclosing document's root scope, so the target compiles correctly:
   *  `binItem` lookups resolve against `bin`, and `"$$NAME"` macros resolve
   *  against `macros` (both lexically scoped up to the document root). Pass
   *  the root document's `bin`/`macros` — for a root-level target that's the
   *  only enclosing scope. */
  rootBin?: BinEntry[];
  rootMacros?: Record<string, unknown>;
  /** Maps a node `source` to a fetchable URL (platform.resolveSource bound). */
  resolveSource: (source: string) => string;
  /** Called per decoded leaf so the caller can surface non-fatal errors
   *  (a leaf whose source can't be decoded is skipped, not fatal). */
  onLeafError?: (source: string, err: unknown) => void;
  /** Called per compile error (missing bin entry, bad script, macro) so the
   *  caller can surface why a composition's audio came up empty. */
  onCompileError?: (message: string) => void;
}

/** A leaf paired with its decoded source-range PCM. */
interface DecodedLeaf {
  leaf: AudioLeaf;
  decoded: MonoRange;
}

function isAudioLeaf(leaf: FlatLeaf): leaf is AudioLeaf {
  return leaf.type === "clip" || leaf.type === "audio";
}

/**
 * Render a composition's audio to a mono 16-bit WAV blob, or null when the
 * composition contributes no decodable audio (caller treats that as "nothing
 * to transcribe").
 */
export async function mixCompositionAudio(
  composition: Composition,
  opts: MixCompositionOptions
): Promise<Blob | null> {
  // Compile the target within the document's root scope first, so `binItem`
  // bodies are spliced, `script`s run, and `$$` macros expand — otherwise a
  // bin-backed or macro-driven composition resolves to nothing. We wrap the
  // target in a synthetic root carrying the document's `bin`/`macros`, which
  // for a root-level target reproduces its exact lexical scope; the compiled
  // child comes back fully resolved.
  const wrapper: Composition = {
    type: "composition",
    children: [composition],
    ...(opts.rootBin ? { bin: opts.rootBin } : {}),
    ...(opts.rootMacros ? { macros: opts.rootMacros } : {}),
  };
  const compiled = compileSeamFile(wrapper, { runScripts: true });
  for (const err of compiled.errors) {
    opts.onCompileError?.(`${err.source}: ${err.message}`);
  }
  const compiledTarget = compiled.doc.children[0];
  if (!compiledTarget || compiledTarget.type !== "composition") return null;

  // Strip top-level attachments for "children only" — AFTER compile, so a
  // `binItem` composition's spliced-in attachments are excluded too. Resolved
  // as root, the comp's own windowing fields are ignored and children lay out
  // from t=0.
  const subject: Composition = opts.includeAttachments
    ? compiledTarget
    : { ...compiledTarget, attachments: [] };

  const resolved = resolveComposition(subject);
  const duration = resolved.duration;
  if (!(duration > 0)) return null;

  const leaves = flattenResolved(resolved.children)
    .filter(isAudioLeaf)
    .filter((l) => l.timelineEnd > l.timelineStart);
  if (leaves.length === 0) return null;

  // Decode each leaf's source range in parallel. A leaf that fails to decode
  // (missing/undecodable source) is dropped with a reported error rather than
  // failing the whole mix.
  const decoded: DecodedLeaf[] = [];
  await Promise.all(
    leaves.map(async (leaf) => {
      try {
        const url = opts.resolveSource(leaf.source);
        const range = await decodeMonoRange(url, leaf.sourceIn, leaf.sourceOut);
        decoded.push({ leaf, decoded: range });
      } catch (err) {
        opts.onLeafError?.(leaf.source, err);
      }
    })
  );
  if (decoded.length === 0) return null;

  // Mix at the highest source sample rate so we don't downsample anyone.
  const sampleRate = decoded.reduce(
    (max, d) => Math.max(max, d.decoded.sampleRate),
    0
  );
  const frames = Math.max(1, Math.ceil(duration * sampleRate));

  // OfflineAudioContext is the same Web Audio resampler the preview uses live;
  // per-leaf playbackRate applies speed, buffers resample to the context rate.
  const ctx = new OfflineAudioContext(1, frames, sampleRate);

  for (const { leaf, decoded: range } of decoded) {
    const buffer = ctx.createBuffer(1, range.samples.length, range.sampleRate);
    // `.set` (vs copyToChannel) sidesteps the Float32Array<ArrayBuffer>
    // typed-array variance mismatch and copies the same PCM.
    buffer.getChannelData(0).set(range.samples);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = leaf.speed;

    const gain = ctx.createGain();
    applyGainEnvelope(gain.gain, leaf, sampleRate);
    node.connect(gain).connect(ctx.destination);

    // The decoded buffer already covers [sourceIn, sourceOut]; at playbackRate
    // = speed its played length is (sourceOut-sourceIn)/speed = the output
    // span. Start at the leaf's output position, stop at its output end.
    node.start(Math.max(0, leaf.timelineStart));
    node.stop(Math.max(0, leaf.timelineEnd));
  }

  const rendered = await ctx.startRendering();
  return encodeWavMono16(rendered.getChannelData(0), sampleRate);
}

/** Sampling step (seconds) for keyframed-volume envelopes. */
const ENVELOPE_STEP = 1 / 30;

/**
 * Schedule a leaf's gain: static or keyframed volume × linear crossfade fades,
 * matching the preview's `audioCrossfadeGain` / volume sampling. Times are
 * absolute output seconds (the OfflineAudioContext timeline).
 */
function applyGainEnvelope(
  param: AudioParam,
  leaf: AudioLeaf,
  sampleRate: number
): void {
  const t0 = Math.max(0, leaf.timelineStart);
  const dur = leaf.timelineEnd - leaf.timelineStart;
  const fadeIn = leaf.transition ?? 0;
  const fadeOut = leaf.transitionOut ?? 0;
  const vol = leaf.volume;
  const keyframed = isKeyframed(vol);

  const gainAt = (local: number): number => {
    let g = vol == null ? 1 : sampleVolume(vol, local, dur);
    if (fadeIn > 0 && local < fadeIn) g *= clamp01(local / fadeIn);
    if (fadeOut > 0) {
      const e = dur - local;
      if (e < fadeOut) g *= clamp01(e / fadeOut);
    }
    return g;
  };

  // Constant gain, no fades: one set is enough.
  if (!keyframed && fadeIn <= 0 && fadeOut <= 0) {
    param.setValueAtTime(gainAt(0), t0);
    return;
  }

  // Otherwise step a piecewise-linear envelope across the leaf's output span.
  // Quantise to the mix's sample grid so we don't emit sub-sample steps.
  const minStep = 1 / sampleRate;
  const step = Math.max(minStep, ENVELOPE_STEP);
  param.setValueAtTime(gainAt(0), t0);
  for (let local = step; local < dur; local += step) {
    param.linearRampToValueAtTime(gainAt(local), t0 + local);
  }
  param.linearRampToValueAtTime(gainAt(dur), t0 + dur);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
