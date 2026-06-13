import type {
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
  ResolvedText,
  ResolvedTimeline,
} from "@seam/core";
import { isKeyframed, sampleNumber } from "@seam/core";
import { AudioBufferSink } from "mediabunny";
import { ClipBuffer } from "./ClipBuffer.js";
import { MediaStore } from "./MediaStore.js";
import { AudioScheduler } from "./AudioScheduler.js";
import { TextStore } from "./TextStore.js";
import { StaticStore } from "./StaticStore.js";
import { GraphicStore } from "./GraphicStore.js";
import { resolveSource } from "../components/resolveSource.js";

/** Seconds of source time to keep buffered ahead of the playhead per clip. */
const LOOKAHEAD = 1.0;
/** Seconds of source time to keep buffered behind the playhead per clip. */
const LOOKBEHIND = 1.0;

/**
 * One flattened leaf — a video clip OR an audio-only clip — with its
 * absolute parent-timeline span and a mapper to source time.
 */
interface FlatClip {
  clip: ResolvedClip | ResolvedAudio;
  absoluteStart: number;
  absoluteEnd: number;
  source: string;
  audioId: string | null;
  toSourceTime: (absoluteTime: number) => number;
}

/** Crossfade gain (0..1) for an audio-bearing clip at `currentTime`: fade in
 *  over its first `transition` seconds and out over its last `transitionOut`
 *  seconds. Audio sums (no occlusion), so both ends ramp — unlike the video
 *  path where only the incoming element fades. */
function audioCrossfadeGain(flat: FlatClip, currentTime: number): number {
  let g = 1;
  const inD = flat.clip.transition;
  if (inD != null && inD > 0) {
    const e = currentTime - flat.absoluteStart;
    if (e < inD) g *= Math.max(0, Math.min(1, e / inD));
  }
  const outD = flat.clip.transitionOut;
  if (outD != null && outD > 0) {
    const e = flat.absoluteEnd - currentTime;
    if (e < outD) g *= Math.max(0, Math.min(1, e / outD));
  }
  return g;
}

export class FrameCoordinator {
  /** Video buffers, keyed by resolved video clips only (audio nodes have none). */
  private buffers = new Map<ResolvedClip, ClipBuffer>();
  private flatClips: FlatClip[] = [];
  private flatByClip = new Map<ResolvedClip | ResolvedAudio, FlatClip>();
  private sizes = new Map<ResolvedClip, { w: number; h: number }>();
  private playingClips = new Set<ResolvedClip | ResolvedAudio>();
  private audioScheduler: AudioScheduler | null = null;
  private textStore = new TextStore();
  private staticStore = new StaticStore();
  private graphicStore = new GraphicStore();
  private ready = false;

  /** Fires when a buffered frame becomes available — used to repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(
    timeline: ResolvedTimeline,
    basePath: string,
    mediaStore: MediaStore,
    audioScheduler: AudioScheduler,
    initialTime: number = 0
  ): Promise<void> {
    this.dispose();
    this.audioScheduler = audioScheduler;

    this.flatClips = collectClips(
      timeline.children,
      (t) => t,
      (t) => t,
      basePath
    );

    // Text nodes rasterize synchronously straight onto OffscreenCanvases
    // via Pretext-laid-out canvas drawing — no SVG / `<img>` decode wait.
    this.textStore.onFrameAvailable = () => this.onFrameAvailable?.();
    this.textStore.setTimeline(timeline);

    // Static nodes decode asynchronously — fire and forget so the
    // initial reconcile doesn't block on them. The first frame
    // available callback will repaint when each decode lands.
    this.staticStore.onFrameAvailable = () => this.onFrameAvailable?.();
    void this.staticStore.setTimeline(timeline, basePath, mediaStore);

    this.graphicStore.onFrameAvailable = () => this.onFrameAvailable?.();
    void this.graphicStore.setTimeline(timeline);

    // Align AudioContext sample rate with the first decodable audio track
    for (const flat of this.flatClips) {
      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (audioTrack && (await audioTrack.canDecode())) {
        audioScheduler.setSampleRate(audioTrack.sampleRate);
        break;
      }
    }

    for (const flat of this.flatClips) {
      this.flatByClip.set(flat.clip, flat);
    }

    const initAll = this.flatClips.map(async (flat) => {
      // Video buffer + intrinsic size only for video clips. Audio-only nodes
      // don't have anything to draw, so no ClipBuffer / no size lookup.
      if (flat.clip.type === "clip") {
        const buffer = new ClipBuffer();
        buffer.onFrameAvailable = () => this.onFrameAvailable?.();
        this.buffers.set(flat.clip, buffer);

        await buffer.init(mediaStore, flat.source);

        const size = await mediaStore.getIntrinsicSize(flat.source);
        if (size.w > 0) this.sizes.set(flat.clip, size);
      }

      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (audioTrack && (await audioTrack.canDecode())) {
        const audioId = `${flat.source}:${flat.clip.sourceIn}:${flat.absoluteStart}`;
        flat.audioId = audioId;
        const audioSink = new AudioBufferSink(audioTrack);
        // Register with the t=0 sample of volume so static and animated
        // clips both start with the right value. Animated clips get
        // updated each tick via setClipVolume.
        const initialVolume = flat.clip.volume == null
          ? 1
          : sampleNumber(flat.clip.volume, 0, flat.absoluteEnd - flat.absoluteStart);
        audioScheduler.registerClip(
          audioId,
          audioSink,
          flat.clip.speed,
          initialVolume
        );
      }
    });

    await Promise.all(initAll);
    this.ready = true;

    // Prime at the actual playhead so the paused frame becomes available
    // without having to wait for a tick or seek.
    this.reconcile(initialTime, false, timeline.duration, false);
  }

  tick(
    currentTime: number,
    isPlaying: boolean,
    duration: number,
    loop: boolean
  ): void {
    if (!this.ready) return;
    this.reconcile(currentTime, isPlaying, duration, loop);
  }

  onPlay(_currentTime: number): void {
    if (!this.ready) return;
    // Force re-evaluation of audio start; clear playingClips so reconcile starts them.
    this.playingClips.clear();
  }

  onSeek(currentTime: number, duration: number, loop: boolean): void {
    if (!this.ready) return;
    this.playingClips.clear();
    this.reconcile(currentTime, false, duration, loop);
  }

  /**
   * Play a brief burst of audio at the given timeline position and then stop
   * after `durationMs`. Used to give the user audible feedback while scrubbing
   * the playhead when not in normal playback. Repeated calls cancel any
   * previous scrub.
   */
  scrub(currentTime: number, durationMs: number = 30): void {
    if (!this.ready || !this.audioScheduler) return;
    const targets: Array<{ id: string; sourceTime: number }> = [];
    for (const flat of this.flatClips) {
      if (!flat.audioId) continue;
      if (currentTime < flat.absoluteStart || currentTime >= flat.absoluteEnd) {
        continue;
      }
      targets.push({
        id: flat.audioId,
        sourceTime: flat.toSourceTime(currentTime),
      });
    }
    this.audioScheduler.scrub(targets, durationMs);
  }

  /**
   * Returns the buffered frame that should be shown for `clip` at
   * `timelineTime`. Reads straight from the clip's buffer rather than from a
   * cached Map, so async frame arrivals (via onFrameAvailable) immediately
   * become visible on the next gpuRender call without needing a reconcile.
   */
  getFrame(
    clip: ResolvedClip | ResolvedText | ResolvedStatic | ResolvedGraphic,
    timelineTime: number
  ): HTMLCanvasElement | OffscreenCanvas | null {
    if (clip.type === "text") {
      return this.textStore.getFrame(clip);
    }
    if (clip.type === "static") {
      return this.staticStore.getFrame(clip);
    }
    if (clip.type === "graphic") {
      return this.graphicStore.getFrame(clip);
    }
    const flat = this.flatByClip.get(clip);
    if (!flat) return null;
    if (timelineTime < flat.absoluteStart || timelineTime >= flat.absoluteEnd) {
      return null;
    }
    const buffer = this.buffers.get(clip);
    if (!buffer) return null;
    return buffer.getFrame(flat.toSourceTime(timelineTime));
  }

  getIntrinsicSize(
    clip: ResolvedClip | ResolvedStatic,
  ): { w: number; h: number } | null {
    if (clip.type === "static") return this.staticStore.getIntrinsicSize(clip);
    return this.sizes.get(clip) ?? null;
  }

  dispose(): void {
    for (const buffer of this.buffers.values()) {
      buffer.dispose();
    }
    this.buffers.clear();
    this.flatClips = [];
    this.flatByClip.clear();
    this.sizes.clear();
    this.playingClips.clear();
    this.textStore.dispose();
    this.staticStore.dispose();
    this.graphicStore.dispose();
    this.ready = false;
  }

  /**
   * Per-tick reconciliation: for every clip, compute its wanted source-time
   * window, update the buffer, and manage audio start/stop.
   */
  private reconcile(
    currentTime: number,
    isPlaying: boolean,
    duration: number,
    loop: boolean
  ): void {
    const windowMin = currentTime - LOOKBEHIND;
    const windowMax = currentTime + LOOKAHEAD;

    for (const flat of this.flatClips) {
      // Video clips have a ClipBuffer; audio-only nodes don't and just need
      // start/stop scheduling against the audio scheduler.
      const buffer =
        flat.clip.type === "clip" ? this.buffers.get(flat.clip) : null;

      // Timeline range of this clip that overlaps the lookahead/lookbehind window
      const overlapStart = Math.max(flat.absoluteStart, windowMin);
      const overlapEnd = Math.min(flat.absoluteEnd, windowMax);

      if (overlapEnd <= overlapStart) {
        // Outside the window: drop video buffer and stop audio
        if (buffer) buffer.clear();
        if (this.playingClips.has(flat.clip)) {
          this.playingClips.delete(flat.clip);
          if (flat.audioId) this.audioScheduler?.stopClip(flat.audioId);
        }
        continue;
      }

      // Convert timeline range to source range and set buffer target (video only)
      if (buffer) {
        const sourceStart = flat.toSourceTime(overlapStart);
        const sourceEnd = flat.toSourceTime(overlapEnd);
        const pivotTimeline = Math.max(
          flat.absoluteStart,
          Math.min(flat.absoluteEnd, currentTime)
        );
        const pivotSource = flat.toSourceTime(pivotTimeline);
        buffer.setWantedRange(
          Math.min(sourceStart, sourceEnd),
          Math.max(sourceStart, sourceEnd),
          pivotSource
        );
      }

      const isActive =
        currentTime >= flat.absoluteStart && currentTime < flat.absoluteEnd;

      if (isActive) {
        if (isPlaying && !this.playingClips.has(flat.clip)) {
          this.playingClips.add(flat.clip);
          if (flat.audioId) {
            const sourceTime = flat.toSourceTime(currentTime);
            this.audioScheduler?.startClip(flat.audioId, sourceTime);
          }
        }
      } else if (this.playingClips.has(flat.clip)) {
        // Clip no longer active — stop audio (buffer may still be in window)
        this.playingClips.delete(flat.clip);
        if (flat.audioId) this.audioScheduler?.stopClip(flat.audioId);
      }
    }

    // Animated text styles: re-rasterize each frame. Static texts noop.
    this.textStore.update(currentTime);
    // Animated graphics: re-rasterize via fabric. Static graphics noop.
    void this.graphicStore.update(currentTime);

    // Animated clip volumes + crossfade gain: sample once per tick and push
    // to the scheduler. Static-volume clips with no transition skip the
    // lookup so we don't wake up the audio param graph every frame for
    // nothing. Crossfades fade the incoming element in over its first
    // `transition` seconds AND the outgoing one out over its last
    // `transitionOut` seconds — audio sums, so both sides must ramp.
    if (this.audioScheduler) {
      for (const flat of this.flatClips) {
        if (!flat.audioId) continue;
        const v = flat.clip.volume;
        const fade = audioCrossfadeGain(flat, currentTime);
        if (!isKeyframed(v) && fade === 1) continue;
        const localT = currentTime - flat.absoluteStart;
        const dur = flat.absoluteEnd - flat.absoluteStart;
        const base = isKeyframed(v) ? sampleNumber(v, localT, dur) : (v ?? 1);
        this.audioScheduler.setClipVolume(flat.audioId, base * fade);
      }
    }

    // Loop wraparound is intentionally not yet handled here — can be added by
    // extending the wanted range across the loop boundary for near-edge clips.
    void duration;
    void loop;
  }
}

function collectClips(
  children: ResolvedChild[],
  toLocalTime: (t: number) => number,
  toAbsoluteTime: (localT: number) => number,
  basePath: string
): FlatClip[] {
  const result: FlatClip[] = [];

  for (const child of children) {
    if (child.type === "clip" || child.type === "audio") {
      const absStart = toAbsoluteTime(child.timelineStart);
      const absEnd = toAbsoluteTime(child.timelineEnd);
      const capturedToLocal = toLocalTime;
      const capturedChild = child;

      result.push({
        clip: child,
        absoluteStart: absStart,
        absoluteEnd: absEnd,
        source: resolveSource(child.source, basePath),
        audioId: null,
        toSourceTime: (t: number) => {
          const local = capturedToLocal(t);
          const clipLocal = Math.max(0, local - capturedChild.timelineStart);
          return capturedChild.sourceIn + clipLocal * capturedChild.speed;
        },
      });
    } else if (child.type === "composition") {
      const parentToLocal = toLocalTime;
      const parentToAbsolute = toAbsoluteTime;
      const comp = child;

      const childToLocal = (t: number): number => {
        const parentLocal = parentToLocal(t);
        return Math.min(
          Math.max(0, (parentLocal - comp.timelineStart) * comp.speed),
          comp.duration
        );
      };
      const childToAbsolute = (localT: number): number => {
        return parentToAbsolute(comp.timelineStart + localT / comp.speed);
      };

      result.push(
        ...collectClips(comp.children, childToLocal, childToAbsolute, basePath)
      );
    }
  }

  return result;
}
