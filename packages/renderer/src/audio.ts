/**
 * Headless audio mixer — the OfflineAudioContext equivalent of the CLI's
 * `ffmpeg-audio.ts` filtergraph. For every audio-bearing node (clip/audio,
 * recursing compositions) it mirrors the same operations:
 *   atrim  → slice [sourceIn, sourceOut] from the decoded source
 *   speed  → AudioBufferSourceNode.playbackRate (pitch-shifted, like asetrate)
 *   pitch  → length-preserving semitone shift (@seam/core's createPitchShifter,
 *            clip pitch + enclosing comp pitches summed)
 *   volume → GainNode (static value or a sampled envelope curve)
 *   afade  → crossfade ramps folded into the gain curve (both ends, since audio sums)
 *   amix   → every node connects to destination (summation)
 * Returns a rendered AudioBuffer (or null when there's no audio), ready to feed
 * mediabunny's AudioBufferSource.
 */
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { OfflineAudioContext, AudioBuffer as NWAudioBuffer } from "node-web-audio-api";
import {
  sampleVolume,
  resolveVolume,
  isKeyframed,
  createPitchShifter,
  loopIterations,
  unrollLoops,
  asExtensionNode,
} from "@seam/core";
import type {
  Keyframed,
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedComposition,
  ResolvedTimeline,
} from "@seam/core";
import { openMediaSource } from "./mediaInput.js";
import type { BlockStores } from "@seam/media-source";

const SR = 48000;

/** An enclosing composition's volume, with its absolute output start + output
 *  duration so it can be sampled (in output time) at any absolute moment. */
interface VolumeEnv {
  volume: Keyframed<number | string>;
  startAbs: number;
  duration: number;
}

interface AudioEntry {
  node: ResolvedClip | ResolvedAudio;
  parentSpeed: number; // ancestor speed product (excludes node.speed)
  start: number; // absolute output start (seconds) of this entry
  /** Played portion of the decoded `[sourceIn, sourceOut]` region, in source
   *  seconds: the whole region for a plain node, one cycle (possibly cut
   *  short) for a looping one. */
  srcOffset: number;
  srcLength: number;
  /** The NODE's absolute output start + length — the axis its own keyframed
   *  `volume` and crossfade ramps run on. Equal to this entry's span unless
   *  the node loops (then each cycle is its own entry). */
  nodeStart: number;
  nodeDuration: number;
  compVolumes: VolumeEnv[]; // enclosing composition volume multipliers
  pitch: number; // net semitone shift (node pitch + enclosing comp pitches)
}

function collectAudioNodes(
  children: ResolvedChild[],
  parentSpeed: number,
  parentDelay: number,
  parentVolumes: VolumeEnv[],
  parentPitch: number,
  out: AudioEntry[],
): void {
  for (const c of children) {
    const ext = asExtensionNode(c);
    if (ext) {
      // An extension container's children live in node-local time at speed 1
      // and inherit every enclosing volume/pitch unchanged (such nodes have
      // neither). A clip pinned to a map still plays its audio.
      if (!ext.children) continue;
      collectAudioNodes(
        ext.children,
        parentSpeed,
        parentDelay + c.timelineStart / parentSpeed,
        parentVolumes,
        parentPitch,
        out,
      );
    } else if (c.type === "composition") {
      const compStartAbs = parentDelay + c.timelineStart / parentSpeed;
      // The comp's own volume runs over its whole span (not per loop cycle).
      const volumes =
        c.volume != null
          ? [
              ...parentVolumes,
              { volume: c.volume, startAbs: compStartAbs, duration: c.timelineEnd - c.timelineStart },
            ]
          : parentVolumes;
      // A looping composition replays its inner window once per cycle:
      // recurse each cycle's (window-cropped) children at that cycle's start.
      const cycles = c.loop ? (unrollLoops([c]) as ResolvedComposition[]) : [c];
      for (const cycle of cycles) {
        collectAudioNodes(
          cycle.children,
          parentSpeed * c.speed,
          parentDelay + cycle.timelineStart / parentSpeed,
          volumes,
          parentPitch + (c.pitch ?? 0),
          out,
        );
      }
    } else if (c.type === "clip" || c.type === "audio") {
      const nodeStart = parentDelay + c.timelineStart / parentSpeed;
      const span = c.timelineEnd - c.timelineStart;
      // One entry per played cycle (a single one for a plain node).
      for (const it of loopIterations(c.loop, span)) {
        out.push({
          node: c,
          parentSpeed,
          start: nodeStart + it.start / parentSpeed,
          srcOffset: it.offset * c.speed,
          srcLength: (it.end - it.start) * c.speed,
          nodeStart,
          nodeDuration: span / parentSpeed,
          compVolumes: parentVolumes,
          pitch: parentPitch + (c.pitch ?? 0),
        });
      }
    }
  }
}

interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Cheap structural check: does the timeline contain any audio-bearing node?
 *  Lets the caller declare the muxer's audio track (which must happen before
 *  `output.start()`) without awaiting the full mix — so the mix can render
 *  concurrently with the frame loop. */
export function timelineHasAudio(timeline: ResolvedTimeline): boolean {
  const entries: AudioEntry[] = [];
  collectAudioNodes(timeline.children, 1, 0, [], 0, entries);
  return entries.length > 0;
}

/** Mix the timeline's audio offline. `null` if nothing contributes audio. */
export async function renderAudioMix(
  timeline: ResolvedTimeline,
  basePath: string,
  durationSec: number,
  stores?: BlockStores,
): Promise<NWAudioBuffer | null> {
  registerMediabunnyServer();
  // Let mediabunny's AudioBufferSink and node-web-audio-api share one class.
  (globalThis as { AudioBuffer?: unknown }).AudioBuffer = NWAudioBuffer;

  const entries: AudioEntry[] = [];
  // Seed with the root composition's own volume (scales everything).
  const rootVolumes: VolumeEnv[] =
    timeline.volume != null
      ? [{ volume: timeline.volume, startAbs: 0, duration: timeline.duration }]
      : [];
  collectAudioNodes(timeline.children, 1, 0, rootVolumes, timeline.pitch ?? 0, entries);
  if (entries.length === 0) return null;

  // Decode only the [inT, outT) region a node actually uses — decoding whole
  // tracks (some clips slice a few seconds from a long source) was the bulk of
  // the startup latency. Cached by source+region so identical slices dedup.
  const cache = new Map<string, DecodedAudio | null>();
  const decodeRegion = async (
    src: string,
    inT: number,
    outT: number,
    reverse: boolean,
  ): Promise<DecodedAudio | null> => {
    const cacheKey = `${src}:${inT}:${outT}:${reverse ? "r" : "f"}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;
    const input = new Input({
      source: openMediaSource(src, basePath, stores),
      formats: ALL_FORMATS,
    });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      cache.set(cacheKey, null);
      return null;
    }
    const sink = new AudioBufferSink(track);
    const chunks: Float32Array[][] = [];
    let sr = track.sampleRate;
    let ch = track.numberOfChannels;
    let firstTs: number | null = null;
    let total = 0;
    // buffers(inT, outT) decodes from the packet covering inT through outT; the
    // first chunk may start slightly before inT, so we trim by its timestamp.
    for await (const { buffer, timestamp } of sink.buffers(inT, outT)) {
      sr = buffer.sampleRate;
      ch = buffer.numberOfChannels;
      if (firstTs === null) firstTs = timestamp;
      const cc: Float32Array[] = [];
      for (let i = 0; i < ch; i++) cc.push(Float32Array.from(buffer.getChannelData(i)));
      chunks.push(cc);
      total += buffer.length;
    }
    if (total === 0 || firstTs === null) {
      cache.set(cacheKey, null);
      return null;
    }
    const startSample = Math.max(0, Math.round((inT - firstTs) * sr));
    const wantLen = Math.round((outT - inT) * sr);
    const endSample = Math.min(total, startSample + wantLen);
    const channels: Float32Array[] = [];
    for (let i = 0; i < ch; i++) {
      const a = new Float32Array(total);
      let off = 0;
      for (const cc of chunks) {
        a.set(cc[i], off);
        off += cc[i].length;
      }
      const region = a.slice(startSample, endSample);
      if (reverse) {
        // A reversed node plays the region back to front. Pad a short decode
        // (source ends before `outT`) to the full length FIRST, so the missing
        // tail becomes leading silence and sample k of the buffer is still
        // source time `outT − k/sr` — offsets into it stay in playback order.
        const full = new Float32Array(Math.max(region.length, wantLen));
        full.set(region);
        channels.push(full.reverse());
      } else {
        channels.push(region);
      }
    }
    const decoded: DecodedAudio = { sampleRate: sr, channels };
    cache.set(cacheKey, decoded);
    return decoded;
  };

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durationSec * SR)), SR);

  for (const entry of entries) {
    const { node, parentSpeed, start, compVolumes, pitch, srcOffset, srcLength } = entry;
    // Decoded once per source+region — a loop's cycles share the buffer.
    const decoded = await decodeRegion(
      node.source,
      node.sourceIn,
      node.sourceOut,
      node.reverse === true,
    );
    if (!decoded || decoded.channels.length === 0) continue;

    const effectiveSpeed = node.speed * parentSpeed;
    const sr = decoded.sampleRate;
    const len = decoded.channels[0].length;
    if (len <= 0) continue;

    const srcCh = decoded.channels.length;
    const region = new NWAudioBuffer({ length: len, numberOfChannels: srcCh, sampleRate: sr });
    for (let i = 0; i < srcCh; i++) {
      region.getChannelData(i).set(decoded.channels[i]);
    }
    const regionLen = node.sourceOut - node.sourceIn;
    const playedLen = Math.min(srcLength, Math.max(0, regionLen - srcOffset));
    if (playedLen <= 0) continue;
    const audioDuration = playedLen / effectiveSpeed;
    // The node's own axis for its volume keyframes + crossfades (== this
    // entry's for a plain node; the full looped span for a loop cycle).
    const nodeDuration = entry.nodeDuration;
    const nodeOffset = start - entry.nodeStart;

    const srcNode = ctx.createBufferSource();
    srcNode.buffer = region;
    srcNode.playbackRate.value = effectiveSpeed;

    const gain = ctx.createGain();
    // Crossfade overlaps are container-local output seconds → /parentSpeed to
    // absolute output, same as the start delay.
    const fadeIn =
      node.transition && node.transition > 0
        ? Math.min(node.transition / parentSpeed, nodeDuration)
        : 0;
    const fadeOut =
      node.transitionOut && node.transitionOut > 0
        ? Math.min(node.transitionOut / parentSpeed, nodeDuration)
        : 0;
    const vol = node.volume;
    // Enclosing-composition volume at absolute output time T (product of every
    // ancestor comp's volume sampled in its own output time). sampleVolume
    // handles static + keyframed + dB uniformly.
    const compVolAt = (T: number): number => {
      let m = 1;
      for (const cv of compVolumes) m *= sampleVolume(cv.volume, T - cv.startAbs, cv.duration);
      return m;
    };
    const hasAnimatedComp = compVolumes.some((cv) => isKeyframed(cv.volume));
    const staticVol = !isKeyframed(vol) && !hasAnimatedComp;

    if (fadeIn === 0 && fadeOut === 0 && staticVol) {
      // All static: comp volumes are constant, so sample at the clip's start.
      gain.gain.value = (vol == null ? 1 : resolveVolume(vol)) * compVolAt(Math.max(0, start));
    } else {
      const n = Math.max(2, Math.ceil(audioDuration * 100));
      const curve = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const tau = (k / (n - 1)) * audioDuration;
        const tauNode = nodeOffset + tau;
        let g = vol == null ? 1 : sampleVolume(vol, tauNode, nodeDuration);
        g *= compVolAt(Math.max(0, start) + tau);
        if (fadeIn > 0) g *= Math.min(1, tauNode / fadeIn);
        if (fadeOut > 0) g *= Math.min(1, (nodeDuration - tauNode) / fadeOut);
        curve[k] = g;
      }
      gain.gain.setValueCurveAtTime(curve, Math.max(0, start), audioDuration);
    }

    if (pitch !== 0) {
      // Length-preserving semitone shift between source and gain. The looped
      // modulation sources start at t=0 and run for the whole offline render;
      // the input is silent outside the clip's span so that's free. Casts:
      // node-web-audio-api's node types mirror the DOM's but aren't declared
      // compatible; the graph is spec-identical (same as sharing AudioBuffer).
      const shifter = createPitchShifter(ctx as unknown as BaseAudioContext, pitch, 0);
      srcNode.connect(shifter.input as never);
      shifter.output.connect(gain as never);
      gain.connect(ctx.destination);
    } else {
      srcNode.connect(gain).connect(ctx.destination);
    }
    if (srcOffset === 0 && playedLen >= regionLen) {
      srcNode.start(Math.max(0, start), 0);
    } else {
      // One cycle of a loop (or a phase-shifted / cut-short one): play just
      // that slice of the shared region buffer.
      srcNode.start(Math.max(0, start), srcOffset, playedLen);
    }
  }

  // Always emit a buffer when the timeline declared audio (matches
  // timelineHasAudio): if every region failed to decode it's silent, but the
  // muxer's audio track — declared up front from timelineHasAudio — still gets
  // filled rather than left empty.
  return ctx.startRendering();
}
