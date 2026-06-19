/**
 * Headless audio mixer — the OfflineAudioContext equivalent of the CLI's
 * `ffmpeg-audio.ts` filtergraph. For every audio-bearing node (clip/audio,
 * recursing compositions) it mirrors the same operations:
 *   atrim  → slice [sourceIn, sourceOut] from the decoded source
 *   speed  → AudioBufferSourceNode.playbackRate (pitch-shifted, like asetrate)
 *   volume → GainNode (static value or a sampled envelope curve)
 *   afade  → crossfade ramps folded into the gain curve (both ends, since audio sums)
 *   amix   → every node connects to destination (summation)
 * Returns a rendered AudioBuffer (or null when there's no audio), ready to feed
 * mediabunny's AudioBufferSource.
 */
import { isAbsolute, join } from "node:path";
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, FilePathSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { OfflineAudioContext, AudioBuffer as NWAudioBuffer } from "node-web-audio-api";
import { sampleNumber, isKeyframed } from "@seam/core";
import type {
  Keyframed,
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedTimeline,
} from "@seam/core";

const SR = 48000;

/** An enclosing composition's volume, with its absolute output start + output
 *  duration so it can be sampled (in output time) at any absolute moment. */
interface VolumeEnv {
  volume: Keyframed<number>;
  startAbs: number;
  duration: number;
}

interface AudioEntry {
  node: ResolvedClip | ResolvedAudio;
  parentSpeed: number; // ancestor speed product (excludes node.speed)
  start: number; // absolute output start (seconds)
  compVolumes: VolumeEnv[]; // enclosing composition volume multipliers
}

function collectAudioNodes(
  children: ResolvedChild[],
  parentSpeed: number,
  parentDelay: number,
  parentVolumes: VolumeEnv[],
  out: AudioEntry[],
): void {
  for (const c of children) {
    if (c.type === "composition") {
      const compStartAbs = parentDelay + c.timelineStart / parentSpeed;
      const volumes =
        c.volume != null
          ? [...parentVolumes, { volume: c.volume, startAbs: compStartAbs, duration: c.duration }]
          : parentVolumes;
      collectAudioNodes(c.children, parentSpeed * c.speed, compStartAbs, volumes, out);
    } else if (c.type === "clip" || c.type === "audio") {
      out.push({
        node: c,
        parentSpeed,
        start: parentDelay + c.timelineStart / parentSpeed,
        compVolumes: parentVolumes,
      });
    }
  }
}

interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

/** Mix the timeline's audio offline. `null` if nothing contributes audio. */
export async function renderAudioMix(
  timeline: ResolvedTimeline,
  basePath: string,
  durationSec: number,
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
  collectAudioNodes(timeline.children, 1, 0, rootVolumes, entries);
  if (entries.length === 0) return null;

  // Decode only the [inT, outT) region a node actually uses — decoding whole
  // tracks (some clips slice a few seconds from a long source) was the bulk of
  // the startup latency. Cached by source+region so identical slices dedup.
  const cache = new Map<string, DecodedAudio | null>();
  const decodeRegion = async (
    src: string,
    inT: number,
    outT: number,
  ): Promise<DecodedAudio | null> => {
    const cacheKey = `${src}:${inT}:${outT}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;
    const path = isAbsolute(src) ? src : join(basePath, src);
    const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
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
      channels.push(a.slice(startSample, endSample));
    }
    const decoded: DecodedAudio = { sampleRate: sr, channels };
    cache.set(cacheKey, decoded);
    return decoded;
  };

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durationSec * SR)), SR);
  let any = false;

  for (const { node, parentSpeed, start, compVolumes } of entries) {
    const decoded = await decodeRegion(node.source, node.sourceIn, node.sourceOut);
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
    const audioDuration = (node.sourceOut - node.sourceIn) / effectiveSpeed;

    const srcNode = ctx.createBufferSource();
    srcNode.buffer = region;
    srcNode.playbackRate.value = effectiveSpeed;

    const gain = ctx.createGain();
    // Crossfade overlaps are container-local output seconds → /parentSpeed to
    // absolute output, same as the start delay.
    const fadeIn =
      node.transition && node.transition > 0
        ? Math.min(node.transition / parentSpeed, audioDuration)
        : 0;
    const fadeOut =
      node.transitionOut && node.transitionOut > 0
        ? Math.min(node.transitionOut / parentSpeed, audioDuration)
        : 0;
    const vol = node.volume;
    // Enclosing-composition volume at absolute output time T (product of every
    // ancestor comp's volume sampled in its own output time). sampleNumber
    // handles static + keyframed uniformly.
    const compVolAt = (T: number): number => {
      let m = 1;
      for (const cv of compVolumes) m *= sampleNumber(cv.volume, T - cv.startAbs, cv.duration);
      return m;
    };
    const hasAnimatedComp = compVolumes.some((cv) => isKeyframed(cv.volume));
    const staticVol = (typeof vol === "number" || vol == null) && !hasAnimatedComp;

    if (fadeIn === 0 && fadeOut === 0 && staticVol) {
      // All static: comp volumes are constant, so sample at the clip's start.
      gain.gain.value = (vol == null ? 1 : (vol as number)) * compVolAt(Math.max(0, start));
    } else {
      const n = Math.max(2, Math.ceil(audioDuration * 100));
      const curve = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const tau = (k / (n - 1)) * audioDuration;
        let g = vol == null ? 1 : sampleNumber(vol, tau, audioDuration);
        g *= compVolAt(Math.max(0, start) + tau);
        if (fadeIn > 0) g *= Math.min(1, tau / fadeIn);
        if (fadeOut > 0) g *= Math.min(1, (audioDuration - tau) / fadeOut);
        curve[k] = g;
      }
      gain.gain.setValueCurveAtTime(curve, Math.max(0, start), audioDuration);
    }

    srcNode.connect(gain).connect(ctx.destination);
    srcNode.start(Math.max(0, start), 0);
    any = true;
  }

  if (!any) return null;
  return ctx.startRendering();
}
