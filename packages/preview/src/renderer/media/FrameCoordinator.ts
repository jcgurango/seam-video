import type {
  ResolvedAudio,
  ResolvedChild,
  ResolvedClip,
  ResolvedComposition,
  ResolvedExtensionNode,
  RegisteredNodeType,
  RegisteredOverlay,
  ExtensionNodeView,
  Seam,
  ResolvedStatic,
  ResolvedTimeline,
} from "@seam/core";
import {
  isKeyframed,
  sampleVolume,
  loopIterations,
  unrollLoops,
  resolvedPlayStart,
  resolvedSignedRate,
  asExtensionNode,
} from "@seam/core";
import type { RenderCommand } from "@seam/compositor";
import { AudioBufferSink } from "mediabunny";
import { ClipBuffer } from "./ClipBuffer.js";
import { MediaStore } from "./MediaStore.js";
import { AudioScheduler } from "./AudioScheduler.js";
import { StaticStore } from "./StaticStore.js";
import {
  clearRasterizers,
  overlayRasterizerFor,
  rasterizerFor,
  subscribeRasterWake,
} from "./nodeRasterizers.js";
import type { OverlayDrawable } from "@seam/compositor";
import { resolveSource } from "../components/resolveSource.js";
import { CutPlanner, type Cut } from "@seam/media-source";

/** Seconds of source time to keep buffered ahead of the playhead per clip. */
const LOOKAHEAD = 1.0;
/** Seconds of source time to keep buffered behind the playhead per clip. */
const LOOKBEHIND = 1.0;
/** When the dense wanted window would span more than this many *source*
 *  seconds (the ±(LOOKAHEAD/LOOKBEHIND) output window × effective speed,
 *  i.e. effective speed > 4), switch the clip's buffer to sparse mode:
 *  buffer only the discrete source times the display will sample, filled by
 *  a keyframe-aware cursor. Dense fill at that rate decodes ~100× more
 *  frames than are ever shown and retains an unbounded canvas window. */
const SPARSE_SOURCE_SPAN = 8;
/** Sparse targets per output second — the display samples at most one frame
 *  per rAF tick; 30/s halves the decode of a 60Hz display for jumps the eye
 *  can't track anyway. */
const SPARSE_FPS = 30;

/**
 * One flattened leaf — a video clip OR an audio-only clip — with its
 * absolute parent-timeline span and a mapper to source time.
 */
interface FlatClip {
  clip: ResolvedClip | ResolvedAudio;
  /** This entry's absolute span. A looping node (`underflow: "loop"`) yields
   *  one FlatClip per played cycle, each with its own buffer + audio
   *  registration, so cycles preload/schedule exactly like sequential clips. */
  absoluteStart: number;
  absoluteEnd: number;
  /** The NODE's absolute span — the axis its keyframed `volume` and
   *  crossfades run on (== the entry's unless the node loops). */
  nodeAbsStart: number;
  nodeAbsEnd: number;
  source: string;
  audioId: string | null;
  toSourceTime: (absoluteTime: number) => number;
  /** |d(sourceTime)/d(outputTime)|: clip `speed` × enclosing comp speeds.
   *  Static per clip (speeds aren't animatable), so buffer mode is too. */
  sourceRate: number;
  /** The clip plays its source backwards (`out < in` / negative `duration`):
   *  `toSourceTime` falls as output time advances. Video needs no special
   *  decode (the buffer's window is a source range either way, refilled at
   *  its low edge); audio decodes in reversed chunks. */
  reverse: boolean;
  /** Product of every enclosing composition's `volume` at a global output
   *  time (each comp sampled in its own output time). `1` when none. */
  compVolumeAt: (globalTime: number) => number;
  /** True when any enclosing composition (or the root) sets `volume`, so the
   *  per-tick loop must keep pushing the multiplier even for static clips. */
  hasCompVolume: boolean;
  /** Net length-preserving pitch shift in semitones: clip `pitch` + every
   *  enclosing composition's `pitch` (semitones add through nesting).
   *  Static — pitch isn't animatable. */
  pitch: number;
}

/** Crossfade gain (0..1) for an audio-bearing clip at `currentTime`: fade in
 *  over its first `transition` seconds and out over its last `transitionOut`
 *  seconds. Audio sums (no occlusion), so both ends ramp — unlike the video
 *  path where only the incoming element fades. */
function audioCrossfadeGain(flat: FlatClip, currentTime: number): number {
  let g = 1;
  const inD = flat.clip.transition;
  if (inD != null && inD > 0) {
    const e = currentTime - flat.nodeAbsStart;
    if (e < inD) g *= Math.max(0, Math.min(1, e / inD));
  }
  const outD = flat.clip.transitionOut;
  if (outD != null && outD > 0) {
    const e = flat.nodeAbsEnd - currentTime;
    if (e < outD) g *= Math.max(0, Math.min(1, e / outD));
  }
  return g;
}

export class FrameCoordinator {
  /** Video buffers, one per video FlatClip (audio entries have none). */
  private buffers = new Map<FlatClip, ClipBuffer>();
  private flatClips: FlatClip[] = [];
  /** Every entry of a resolved node — several when it loops. */
  private flatByClip = new Map<ResolvedClip | ResolvedAudio, FlatClip[]>();
  private sizes = new Map<ResolvedClip, { w: number; h: number }>();
  /** Display dims by `source` + orientation. Survives `setTimeline` (media
   *  dims don't change), so layout stays stable while buffers re-prime and
   *  tools holding a different resolved tree (the editor's viewport gizmo)
   *  can ask by source instead of by node identity. */
  private sizesBySource = new Map<string, { w: number; h: number }>();
  private hasStatics = false;
  /** Fires when a clip/static's intrinsic size becomes known. */
  onMediaSize: (() => void) | null = null;
  private playingClips = new Set<FlatClip>();
  private audioScheduler: AudioScheduler | null = null;
  private staticStore = new StaticStore();
  /** The Seam instance's contributed node types — where rasterizers for
   *  self-drawing extension nodes (a map) come from. */
  private readonly nodeTypes: ReadonlyMap<string, RegisteredNodeType>;
  /** The Seam instance's overlays (the Captions layer). */
  private readonly overlays: readonly RegisteredOverlay[];
  /** This frame's canvas per self-drawing extension node / overlay draw. */
  private nodeFrames = new Map<
    ResolvedExtensionNode | OverlayDrawable,
    HTMLCanvasElement | OffscreenCanvas
  >();
  private rasterWakeUnsub: (() => void) | null = null;

  /** `extensions`: the host's Seam instance. */
  constructor(
    extensions: Pick<Seam, "nodeTypes" | "overlays"> = { nodeTypes: new Map(), overlays: [] },
  ) {
    this.nodeTypes = extensions.nodeTypes;
    this.overlays = extensions.overlays;
  }
  private ready = false;
  /** Bumped on each setTimeline. An in-flight (async) setTimeline checks this
   *  after every await and bails if a newer one started — otherwise its decode
   *  callbacks land after the next dispose() and leak ClipBuffers / audio
   *  registrations into the rebuilt coordinator (resize-drag churn). */
  private generation = 0;

  /** Fires when a buffered frame becomes available — used to repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  /** Timeline-driven prefetch + eviction for remote (cloud) sources: warms
   *  each upcoming cut's bytes (keyframe → out point) into the MediaStore's
   *  block cache ahead of the ±1 s decode window, and ranks the cache by
   *  distance from the playhead. Fed from `reconcile`. */
  private planner: CutPlanner | null = null;

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
      rootVol != null,
      1,
      timeline.pitch ?? 0
    );
    this.planner = new CutPlanner({ stores: mediaStore.stores });
    this.planner.setCuts(
      this.flatClips.map((flat, i): Cut => {
        const a = flat.toSourceTime(flat.absoluteStart);
        const b = flat.toSourceTime(flat.absoluteEnd);
        return {
          id: String(i),
          kind: flat.clip.type,
          source: flat.source,
          sourceIn: Math.min(a, b),
          sourceOut: Math.max(a, b),
          start: flat.absoluteStart,
          end: flat.absoluteEnd,
        };
      }),
    );

    // Static nodes decode asynchronously — fire and forget so the
    // initial reconcile doesn't block on them. The first frame
    // available callback will repaint when each decode lands.
    this.staticStore.onFrameAvailable = () => {
      this.onFrameAvailable?.();
      this.onMediaSize?.();
    };
    this.hasStatics = containsStatic(timeline.children);
    void this.staticStore.setTimeline(timeline, basePath, mediaStore);

    // Self-drawing extension nodes (a map) rasterize per frame from the
    // render list (applyContentSizes); repaint when their content lands.
    this.rasterWakeUnsub ??= subscribeRasterWake(() => this.onFrameAvailable?.());

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
      const list = this.flatByClip.get(flat.clip);
      if (list) list.push(flat);
      else this.flatByClip.set(flat.clip, [flat]);
    }

    const initAll = this.flatClips.map(async (flat) => {
      // Video buffer + intrinsic size only for video clips. Audio-only nodes
      // don't have anything to draw, so no ClipBuffer / no size lookup.
      if (flat.clip.type === "clip") {
        const buffer = new ClipBuffer();
        buffer.onFrameAvailable = () => this.onFrameAvailable?.();
        await buffer.init(mediaStore, flat.source, flat.clip.orientation ?? 0);
        // Commit the buffer only if we're still the current timeline —
        // otherwise dispose it locally so its CanvasSink/decoder doesn't leak.
        if (gen !== this.generation) {
          buffer.dispose();
          return;
        }
        this.buffers.set(flat, buffer);

        const size = await mediaStore.getIntrinsicSize(flat.source);
        if (gen !== this.generation) return;
        if (size.w > 0 && !this.sizes.has(flat.clip)) {
          // A 90/270 pre-transform orientation swaps the display dims
          // objectFit sees (mirrors the renderer's intrinsicSize).
          const o = flat.clip.orientation ?? 0;
          const oriented = o === 90 || o === 270 ? { w: size.h, h: size.w } : size;
          this.sizes.set(flat.clip, oriented);
          this.sizesBySource.set(clipSizeKey(flat.clip.source, o), oriented);
          this.onMediaSize?.();
        }
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
          : sampleVolume(
              flat.clip.volume,
              flat.absoluteStart - flat.nodeAbsStart,
              flat.nodeAbsEnd - flat.nodeAbsStart,
            );
        const initialVolume = baseVolume * flat.compVolumeAt(flat.absoluteStart);
        // Composed rate (clip speed × enclosing comp speeds), NOT clip.speed:
        // the scheduler uses it both as playbackRate and to map source-time
        // offsets to output time, so a clip nested in a speeded comp needs
        // the product (mirrors the renderer's `effectiveSpeed` in audio.ts).
        audioScheduler.registerClip(
          audioId,
          audioSink,
          flat.sourceRate,
          initialVolume,
          flat.pitch,
          flat.reverse
        );
      }
    });

    await Promise.all(initAll);
    if (gen !== this.generation) return; // a newer setTimeline owns state now
    this.ready = true;

    // Prime at the actual playhead so the paused frame becomes available
    // without having to wait for a tick or seek.
    this.reconcile(initialTime, false, timeline.duration, false);

    // Extension draws and overlays (a map, the captions layer) only rasterize
    // once `ready` (applyContentSizes), so the paint `<Timeline>` does right
    // after handing over a timeline of purely synchronous content came too
    // early for them — repaint now. With clips / statics their first frame
    // triggers it instead.
    if (!this.hasAsyncFrames) this.onFrameAvailable?.();
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
  /** Push the compositor's per-frame inner-canvas sizes (text / extension
   *  nodes) from a freshly-built render list into the stores, so an animated
   *  `contentWidth` reflows/resizes the rasterized texture. Call right before
   *  `getFrame` in the render pass — self-drawing extension nodes (text, a
   *  map) rasterize here for the draw's node-local
   *  `drawTime` (so nested-composition time mapping lives in the render list
   *  alone). */
  applyContentSizes(commands: RenderCommand[], currentTime: number): void {
    if (!this.ready) return;
    const walk = (cmds: RenderCommand[]): void => {
      for (const c of cmds) {
        if (c.type === "draw") {
          if (c.contentW == null || c.contentH == null) continue;
          const node = c.clip;
          if ("overlay" in node) {
            // An extension overlay at a surface (captions): `drawTime` is
            // the surface's inner time.
            const canvas = overlayRasterizerFor(this.overlays, node.overlay)?.draw(
              node.surface,
              c.drawTime,
              c.contentW,
              c.contentH,
            );
            if (canvas) this.nodeFrames.set(node, canvas as unknown as HTMLCanvasElement);
            else this.nodeFrames.delete(node);
          } else if ("extension" in node) {
            const canvas = rasterizerFor(this.nodeTypes, node.type)?.draw(
              node as unknown as ExtensionNodeView,
              c.drawTime,
              c.contentW,
              c.contentH,
            );
            if (canvas) this.nodeFrames.set(node, canvas as unknown as HTMLCanvasElement);
            else this.nodeFrames.delete(node);
          }
        } else if (c.type === "group") {
          walk(c.children);
        }
      }
    };
    walk(commands);
  }

  getFrame(
    clip: ResolvedClip | ResolvedStatic | ResolvedExtensionNode | OverlayDrawable,
    timelineTime: number
  ): HTMLCanvasElement | OffscreenCanvas | null {
    if ("overlay" in clip || "extension" in clip) {
      return this.nodeFrames.get(clip) ?? null;
    }
    if (clip.type === "static") {
      return this.staticStore.getFrame(clip);
    }
    const entries = this.flatByClip.get(clip);
    if (!entries) return null;
    // The entry (loop cycle) active at this instant.
    const flat = entries.find(
      (f) => timelineTime >= f.absoluteStart && timelineTime < f.absoluteEnd,
    );
    if (!flat) return null;
    const buffer = this.buffers.get(flat);
    if (!buffer) return null;
    return buffer.getFrame(flat.toSourceTime(timelineTime));
  }

  getIntrinsicSize(
    clip: ResolvedClip | ResolvedStatic | ResolvedExtensionNode,
    t = 0,
  ): { w: number; h: number } | null {
    // An extension node that measures its own inner canvas (unwrapped text).
    if ("extension" in clip) {
      const size = rasterizerFor(this.nodeTypes, clip.type)?.measure?.(
        clip as unknown as ExtensionNodeView,
        t,
      );
      return size ? { w: size.width, h: size.height } : null;
    }
    if (clip.type === "static") return this.staticStore.getIntrinsicSize(clip);
    return (
      this.sizes.get(clip) ??
      this.sizesBySource.get(clipSizeKey(clip.source, clip.orientation ?? 0)) ??
      null
    );
  }

  /** True when the current timeline has video clips or statics — media whose
   *  frames decode asynchronously and announce themselves through
   *  `onFrameAvailable`. Without any, nothing would ever ask for a repaint
   *  after `setTimeline`. */
  get hasAsyncFrames(): boolean {
    return this.hasStatics || this.flatClips.some((flat) => flat.clip.type === "clip");
  }

  /** Intrinsic display size of a clip/static by its authored `source` (and a
   *  clip's `orientation`) — for callers that don't hold this timeline's
   *  resolved node objects. Null until the media has been probed. */
  getMediaSize(node: {
    type: "clip" | "static";
    source: string;
    orientation?: number;
  }): { w: number; h: number } | null {
    if (node.type === "static") return this.staticStore.getSizeBySource(node.source);
    return this.sizesBySource.get(clipSizeKey(node.source, node.orientation ?? 0)) ?? null;
  }

  dispose(): void {
    this.planner?.dispose();
    this.planner = null;
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
    this.staticStore.dispose();
    this.nodeFrames.clear();
    clearRasterizers(this.nodeTypes, this.overlays);
    this.rasterWakeUnsub?.();
    this.rasterWakeUnsub = null;
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
    this.planner?.update(currentTime);

    for (const flat of this.flatClips) {
      // Video clips have a ClipBuffer; audio-only nodes don't and just need
      // start/stop scheduling against the audio scheduler.
      const buffer =
        flat.clip.type === "clip" ? this.buffers.get(flat) : null;

      // Timeline range of this clip that overlaps the lookahead/lookbehind window
      const overlapStart = Math.max(flat.absoluteStart, windowMin);
      const overlapEnd = Math.min(flat.absoluteEnd, windowMax);

      if (overlapEnd <= overlapStart) {
        // Outside the window: drop video buffer and stop audio
        if (buffer) buffer.clear();
        if (this.playingClips.has(flat)) {
          this.playingClips.delete(flat);
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
        const rate = Math.abs(flat.sourceRate);
        if (rate * (LOOKAHEAD + LOOKBEHIND) > SPARSE_SOURCE_SPAN) {
          // High effective speed: buffer only the source times the display
          // will sample, on a stable quantized grid.
          buffer.setWantedTimes(
            flat.reverse
              ? sparseTargetGridReverse(
                  pivotSource,
                  Math.min(sourceStart, sourceEnd),
                  rate
                )
              : sparseTargetGrid(
                  pivotSource,
                  Math.max(sourceStart, sourceEnd),
                  rate
                ),
            pivotSource,
            flat.reverse
          );
        } else {
          buffer.setWantedRange(
            Math.min(sourceStart, sourceEnd),
            Math.max(sourceStart, sourceEnd),
            pivotSource
          );
        }
      }

      // Audio pre-rolls like video: a clip's decode starts as soon as its
      // start enters the lookahead window, with its buffers scheduled at
      // their future context times and a stop at its end. Starting only
      // once the playhead crosses in (as before) left each clip exactly its
      // own lifetime to go from a cold decoder to a first scheduled buffer —
      // a run of short clips never sounded at all.
      const audioWanted =
        isPlaying &&
        flat.absoluteStart < windowMax &&
        currentTime < flat.absoluteEnd;

      if (audioWanted) {
        if (!this.playingClips.has(flat)) {
          this.playingClips.add(flat);
          if (flat.audioId && this.audioScheduler) {
            const startAt = Math.max(flat.absoluteStart, currentTime);
            this.audioScheduler.startClip(
              flat.audioId,
              flat.toSourceTime(startAt),
              {
                at: this.audioScheduler.contextTimeFor(startAt),
                until: this.audioScheduler.contextTimeFor(flat.absoluteEnd),
              },
            );
          }
        }
      } else if (this.playingClips.has(flat)) {
        // Clip no longer wanted — stop audio (buffer may still be in window)
        this.playingClips.delete(flat);
        if (flat.audioId) this.audioScheduler?.stopClip(flat.audioId);
      }
    }

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
        // Keyframed volume runs on the NODE's span (a loop cycle is a slice).
        const localT = currentTime - flat.nodeAbsStart;
        const dur = flat.nodeAbsEnd - flat.nodeAbsStart;
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

/** Sparse-mode wanted times: a quantized source-time grid from just behind
 *  the pivot through the end of the wanted window. Grid values are stable as
 *  the window slides (they're multiples of the spacing, not offsets from the
 *  continuous playhead), which is what lets ClipBuffer's high-water mark
 *  recognize already-filled targets across ticks. */
function sparseTargetGrid(
  pivotSource: number,
  sourceEnd: number,
  rate: number
): number[] {
  const spacing = rate / SPARSE_FPS;
  const first = Math.max(0, Math.floor((pivotSource - 2 * spacing) / spacing));
  const out: number[] = [];
  // ~SPARSE_FPS × LOOKAHEAD targets; hard cap as a defensive bound.
  for (let n = first; n * spacing <= sourceEnd && out.length < 90; n++) {
    out.push(n * spacing);
  }
  return out;
}

/** Mirror of {@link sparseTargetGrid} for a reversed clip: the same quantized
 *  grid, from just above the pivot DOWN to the low end of the wanted window
 *  (the direction playback is heading). Returned ascending. */
function sparseTargetGridReverse(
  pivotSource: number,
  sourceMin: number,
  rate: number
): number[] {
  const spacing = rate / SPARSE_FPS;
  const top = Math.ceil((pivotSource + 2 * spacing) / spacing);
  const out: number[] = [];
  for (let n = top; n >= 0 && n * spacing >= sourceMin && out.length < 90; n--) {
    out.push(n * spacing);
  }
  return out.reverse();
}

function collectClips(
  children: ResolvedChild[],
  toLocalTime: (t: number) => number,
  toAbsoluteTime: (localT: number) => number,
  basePath: string,
  volumeAt: (globalTime: number) => number,
  hasVol: boolean,
  parentRate: number = 1,
  parentPitch: number = 0
): FlatClip[] {
  const result: FlatClip[] = [];

  for (const child of children) {
    if (child.type === "clip" || child.type === "audio") {
      const nodeAbsStart = toAbsoluteTime(child.timelineStart);
      const nodeAbsEnd = toAbsoluteTime(child.timelineEnd);
      const capturedToLocal = toLocalTime;
      const capturedChild = child;
      const span = child.timelineEnd - child.timelineStart;

      // One entry per played cycle — a single one for a plain node. A loop
      // cycle maps its own slice of the clip's source range.
      for (const it of loopIterations(child.loop, span)) {
        const iterLocalStart = child.timelineStart + it.start;
        // Signed: a reversed clip starts at `sourceOut` and counts down.
        const signedRate = resolvedSignedRate(child);
        const srcBase = resolvedPlayStart(child) + it.offset * signedRate;
        result.push({
          clip: child,
          absoluteStart: toAbsoluteTime(iterLocalStart),
          absoluteEnd: toAbsoluteTime(child.timelineStart + it.end),
          nodeAbsStart,
          nodeAbsEnd,
          source: resolveSource(child.source, basePath),
          audioId: null,
          toSourceTime: (t: number) => {
            const local = capturedToLocal(t);
            const clipLocal = Math.max(0, local - iterLocalStart);
            return srcBase + clipLocal * signedRate;
          },
          sourceRate: parentRate * child.speed,
          reverse: capturedChild.reverse === true,
          compVolumeAt: volumeAt,
          hasCompVolume: hasVol,
          pitch: parentPitch + (child.pitch ?? 0),
        });
      }
    } else if (child.type === "composition") {
      const parentToLocal = toLocalTime;
      const parentToAbsolute = toAbsoluteTime;
      const comp = child;
      // Compose this comp's own volume (sampled in its output time, over the
      // comp's whole span — not per loop cycle) onto the enclosing
      // multiplier, for every clip beneath it.
      const compAbsStart = parentToAbsolute(comp.timelineStart);
      const compSpan = comp.timelineEnd - comp.timelineStart;
      const compVol = comp.volume;
      const childVolumeAt = compVol != null
        ? (t: number) => volumeAt(t) * sampleVolume(compVol, t - compAbsStart, compSpan)
        : volumeAt;
      const childHasVol = hasVol || compVol != null;

      // A looping composition replays its inner window once per cycle: walk
      // each cycle's (window-cropped) children with that cycle's own time
      // mapping, so every cycle gets its own buffers + audio schedule.
      const cycles = comp.loop ? (unrollLoops([comp]) as ResolvedComposition[]) : [comp];
      for (const cycle of cycles) {
        const childToLocal = (t: number): number => {
          const parentLocal = parentToLocal(t);
          // Clamp to the composition's *inner-window* span, not its output
          // `duration`: nested clips live in inner coords (span = duration ×
          // speed, since windowDur = span / speed). Clamping to `duration` pinned
          // inner time at the output length, freezing the first child and
          // collapsing every later child onto its `sourceIn` (frame 0). Mirrors
          // the compositor's RenderList clamp.
          return Math.min(
            Math.max(0, (parentLocal - cycle.timelineStart) * comp.speed),
            cycle.duration * comp.speed
          );
        };
        const childToAbsolute = (localT: number): number => {
          return parentToAbsolute(cycle.timelineStart + localT / comp.speed);
        };

        result.push(
          ...collectClips(
            cycle.children,
            childToLocal,
            childToAbsolute,
            basePath,
            childVolumeAt,
            childHasVol,
            parentRate * comp.speed,
            parentPitch + (comp.pitch ?? 0)
          )
        );
      }
    } else if (asExtensionNode(child)?.children) {
      // An extension container's children (a map's): node-local time (0 =
      // the node's start) at speed 1; the node itself has no volume/pitch,
      // so the enclosing multipliers pass through.
      const parentToLocal = toLocalTime;
      const parentToAbsolute = toAbsoluteTime;
      const map = asExtensionNode(child)!;
      result.push(
        ...collectClips(
          map.children!,
          (t: number) => parentToLocal(t) - map.timelineStart,
          (localT: number) => parentToAbsolute(map.timelineStart + localT),
          basePath,
          volumeAt,
          hasVol,
          parentRate,
          parentPitch
        )
      );
    }
  }

  return result;
}

function clipSizeKey(source: string, orientation: number): string {
  return `${orientation}\n${source}`;
}

function containsStatic(children: ResolvedChild[]): boolean {
  return children.some(
    (c) =>
      c.type === "static" ||
      (c.type === "composition" && containsStatic(c.children)) ||
      containsStatic(asExtensionNode(c)?.children ?? []),
  );
}
