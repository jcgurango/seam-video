import type {
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedGraphic,
  ResolvedStatic,
  ResolvedText,
  ResolvedTimeline,
} from "@seam/core";
import { isKeyframed, sampleVolume } from "@seam/core";
import type { RenderCommand } from "@seam/compositor";
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
  /** Product of every enclosing composition's `volume` at a global output
   *  time (each comp sampled in its own output time). `1` when none. */
  compVolumeAt: (globalTime: number) => number;
  /** True when any enclosing composition (or the root) sets `volume`, so the
   *  per-tick loop must keep pushing the multiplier even for static clips. */
  hasCompVolume: boolean;
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
  /** Bumped on each setTimeline. An in-flight (async) setTimeline checks this
   *  after every await and bails if a newer one started — otherwise its decode
   *  callbacks land after the next dispose() and leak ClipBuffers / audio
   *  registrations into the rebuilt coordinator (resize-drag churn). */
  private generation = 0;

  /** Fires when a buffered frame becomes available — used to repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(
    timeline: ResolvedTimeline,
    basePath: string,
    mediaStore: MediaStore,
    audioScheduler: AudioScheduler,
    initialTime: number = 0
  ): Promise<void> {
    const gen = ++this.generation;
    this.dispose();
    this.audioScheduler = audioScheduler;

    // Seed with the root composition's own volume (scales everything).
    const rootVol = timeline.volume;
    const rootVolumeAt = rootVol != null
      ? (t: number) => sampleVolume(rootVol, t, timeline.duration)
      : () => 1;
    this.flatClips = collectClips(
      timeline.children,
      (t) => t,
      (t) => t,
      basePath,
      rootVolumeAt,
      rootVol != null
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
    void this.graphicStore.setTimeline(timeline, basePath);

    // Align AudioContext sample rate with the first decodable audio track
    for (const flat of this.flatClips) {
      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (gen !== this.generation) return; // superseded by a newer setTimeline
      if (audioTrack && (await audioTrack.canDecode())) {
        if (gen !== this.generation) return;
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
        await buffer.init(mediaStore, flat.source);
        // Commit the buffer only if we're still the current timeline —
        // otherwise dispose it locally so its CanvasSink/decoder doesn't leak.
        if (gen !== this.generation) {
          buffer.dispose();
          return;
        }
        this.buffers.set(flat.clip, buffer);

        const size = await mediaStore.getIntrinsicSize(flat.source);
        if (gen !== this.generation) return;
        if (size.w > 0) this.sizes.set(flat.clip, size);
      }

      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (gen !== this.generation) return;
      if (audioTrack && (await audioTrack.canDecode())) {
        if (gen !== this.generation) return;
        const audioId = `${flat.source}:${flat.clip.sourceIn}:${flat.absoluteStart}`;
        flat.audioId = audioId;
        const audioSink = new AudioBufferSink(audioTrack);
        // Register with the t=0 sample of volume so static and animated
        // clips both start with the right value. Animated clips get
        // updated each tick via setClipVolume.
        const baseVolume = flat.clip.volume == null
          ? 1
          : sampleVolume(flat.clip.volume, 0, flat.absoluteEnd - flat.absoluteStart);
        const initialVolume = baseVolume * flat.compVolumeAt(flat.absoluteStart);
        audioScheduler.registerClip(
          audioId,
          audioSink,
          flat.clip.speed,
          initialVolume
        );
      }
    });

    await Promise.all(initAll);
    if (gen !== this.generation) return; // a newer setTimeline owns state now
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
  /** Push the compositor's per-frame inner-canvas sizes (text/graphic) from a
   *  freshly-built render list into the text/graphic stores, so an animated
   *  `contentWidth` reflows/resizes the rasterized texture. Call right before
   *  `getFrame` in the render pass — text resizes synchronously, graphics
   *  schedule an async redraw (prior frame held until ready). */
  applyContentSizes(commands: RenderCommand[], currentTime: number): void {
    if (!this.ready) return;
    const textSizes = new Map<ResolvedText, { w: number; h: number }>();
    const graphicSizes = new Map<ResolvedGraphic, { w: number; h: number }>();
    const walk = (cmds: RenderCommand[]): void => {
      for (const c of cmds) {
        if (c.type === "draw") {
          if (c.contentW == null || c.contentH == null) continue;
          const node = c.clip;
          if (node.type === "text")
            textSizes.set(node, { w: c.contentW, h: c.contentH });
          else if (node.type === "graphic")
            graphicSizes.set(node, { w: c.contentW, h: c.contentH });
        } else if (c.type === "group") {
          walk(c.children);
        }
      }
    };
    walk(commands);
    if (textSizes.size > 0) this.textStore.setContentSizes(textSizes, currentTime);
    if (graphicSizes.size > 0)
      this.graphicStore.setContentSizes(graphicSizes, currentTime);
  }

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
    // Tear down every audio clip we registered (this coordinator owns them
    // 1:1). Without this, each setTimeline left the previous timeline's clips
    // connected in the scheduler — a resize drag (many rebuilds/sec, with
    // shifting audioIds) piled up GainNodes/sinks until playback choked.
    this.audioScheduler?.unregisterAll();
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
        // Skip only when nothing varies — static clip volume, no crossfade, and
        // no enclosing composition volume to apply.
        if (!isKeyframed(v) && fade === 1 && !flat.hasCompVolume) continue;
        const localT = currentTime - flat.absoluteStart;
        const dur = flat.absoluteEnd - flat.absoluteStart;
        const base = sampleVolume(v ?? 1, localT, dur);
        const compVol = flat.compVolumeAt(currentTime);
        // Pass the crossfade `fade` separately so it stays a transient — the
        // scheduler keeps `base * compVol` as the steady state it restores to,
        // otherwise a faded-out clip restarts muted on its next play.
        this.audioScheduler.setClipVolume(flat.audioId, base * compVol, fade);
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
  basePath: string,
  volumeAt: (globalTime: number) => number,
  hasVol: boolean
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
        compVolumeAt: volumeAt,
        hasCompVolume: hasVol,
      });
    } else if (child.type === "composition") {
      const parentToLocal = toLocalTime;
      const parentToAbsolute = toAbsoluteTime;
      const comp = child;
      // Compose this comp's own volume (sampled in its output time) onto the
      // enclosing multiplier, for every clip beneath it.
      const compAbsStart = parentToAbsolute(comp.timelineStart);
      const compVol = comp.volume;
      const childVolumeAt = compVol != null
        ? (t: number) => volumeAt(t) * sampleVolume(compVol, t - compAbsStart, comp.duration)
        : volumeAt;
      const childHasVol = hasVol || compVol != null;

      const childToLocal = (t: number): number => {
        const parentLocal = parentToLocal(t);
        // Clamp to the composition's *inner-window* span, not its output
        // `duration`: nested clips live in inner coords (span = duration ×
        // speed, since windowDur = span / speed). Clamping to `duration` pinned
        // inner time at the output length, freezing the first child and
        // collapsing every later child onto its `sourceIn` (frame 0). Mirrors
        // the compositor's RenderList clamp.
        return Math.min(
          Math.max(0, (parentLocal - comp.timelineStart) * comp.speed),
          comp.duration * comp.speed
        );
      };
      const childToAbsolute = (localT: number): number => {
        return parentToAbsolute(comp.timelineStart + localT / comp.speed);
      };

      result.push(
        ...collectClips(
          comp.children,
          childToLocal,
          childToAbsolute,
          basePath,
          childVolumeAt,
          childHasVol
        )
      );
    }
  }

  return result;
}
