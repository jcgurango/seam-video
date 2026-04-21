import type { ResolvedChild, ResolvedClip, ResolvedTimeline } from "@seam/core";
import { AudioBufferSink } from "mediabunny";
import { ClipBuffer } from "./ClipBuffer.js";
import { MediaStore } from "./MediaStore.js";
import { AudioScheduler } from "./AudioScheduler.js";
import { resolveSource } from "../components/resolveSource.js";

/** Seconds of source time to keep buffered ahead of the playhead per clip. */
const LOOKAHEAD = 1.0;
/** Seconds of source time to keep buffered behind the playhead per clip. */
const LOOKBEHIND = 1.0;

interface FlatClip {
  clip: ResolvedClip;
  absoluteStart: number;
  absoluteEnd: number;
  source: string;
  audioId: string | null;
  toSourceTime: (absoluteTime: number) => number;
}

export class FrameCoordinator {
  private buffers = new Map<ResolvedClip, ClipBuffer>();
  private flatClips: FlatClip[] = [];
  private frames = new Map<ResolvedClip, HTMLCanvasElement | OffscreenCanvas>();
  private sizes = new Map<ResolvedClip, { w: number; h: number }>();
  private playingClips = new Set<ResolvedClip>();
  private audioScheduler: AudioScheduler | null = null;
  private ready = false;

  /** Fires when a buffered frame becomes available — used to repaint while paused. */
  onFrameAvailable: (() => void) | null = null;

  async setTimeline(
    timeline: ResolvedTimeline,
    basePath: string,
    mediaStore: MediaStore,
    audioScheduler: AudioScheduler
  ): Promise<void> {
    this.dispose();
    this.audioScheduler = audioScheduler;

    this.flatClips = collectClips(
      timeline.children,
      (t) => t,
      (t) => t,
      basePath
    );

    // Align AudioContext sample rate with the first decodable audio track
    for (const flat of this.flatClips) {
      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (audioTrack && (await audioTrack.canDecode())) {
        audioScheduler.setSampleRate(audioTrack.sampleRate);
        break;
      }
    }

    const initAll = this.flatClips.map(async (flat) => {
      const buffer = new ClipBuffer();
      buffer.onFrameAvailable = () => this.onFrameAvailable?.();
      this.buffers.set(flat.clip, buffer);

      await buffer.init(mediaStore, flat.source);

      const size = await mediaStore.getIntrinsicSize(flat.source);
      if (size.w > 0) this.sizes.set(flat.clip, size);

      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (audioTrack && (await audioTrack.canDecode())) {
        const audioId = `${flat.source}:${flat.clip.sourceIn}:${flat.absoluteStart}`;
        flat.audioId = audioId;
        const audioSink = new AudioBufferSink(audioTrack);
        audioScheduler.registerClip(audioId, audioSink, flat.clip.speed);
      }
    });

    await Promise.all(initAll);
    this.ready = true;

    // Prime at t=0 so the initial frame is available
    this.reconcile(0, false, timeline.duration, false);
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

  getFrame(clip: ResolvedClip): HTMLCanvasElement | OffscreenCanvas | null {
    return this.frames.get(clip) ?? null;
  }

  getIntrinsicSize(clip: ResolvedClip): { w: number; h: number } | null {
    return this.sizes.get(clip) ?? null;
  }

  dispose(): void {
    for (const buffer of this.buffers.values()) {
      buffer.dispose();
    }
    this.buffers.clear();
    this.flatClips = [];
    this.frames.clear();
    this.sizes.clear();
    this.playingClips.clear();
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
      const buffer = this.buffers.get(flat.clip);
      if (!buffer) continue;

      // Timeline range of this clip that overlaps the lookahead/lookbehind window
      const overlapStart = Math.max(flat.absoluteStart, windowMin);
      const overlapEnd = Math.min(flat.absoluteEnd, windowMax);

      if (overlapEnd <= overlapStart) {
        // Clip is outside the window: drop its buffer and stop audio
        buffer.clear();
        this.frames.delete(flat.clip);
        if (this.playingClips.has(flat.clip)) {
          this.playingClips.delete(flat.clip);
          if (flat.audioId) this.audioScheduler?.stopClip(flat.audioId);
        }
        continue;
      }

      // Convert timeline range to source range and set buffer target
      const sourceStart = flat.toSourceTime(overlapStart);
      const sourceEnd = flat.toSourceTime(overlapEnd);
      const pivotTimeline = Math.max(
        flat.absoluteStart,
        Math.min(flat.absoluteEnd, currentTime)
      );
      const pivotSource = flat.toSourceTime(pivotTimeline);

      // Sources can have reversed direction if speed is negative (unsupported),
      // otherwise sourceStart ≤ sourceEnd.
      buffer.setWantedRange(
        Math.min(sourceStart, sourceEnd),
        Math.max(sourceStart, sourceEnd),
        pivotSource
      );

      const isActive =
        currentTime >= flat.absoluteStart && currentTime < flat.absoluteEnd;

      if (isActive) {
        const sourceTime = flat.toSourceTime(currentTime);

        // Start audio if it's time
        if (isPlaying && !this.playingClips.has(flat.clip)) {
          this.playingClips.add(flat.clip);
          if (flat.audioId) {
            this.audioScheduler?.startClip(flat.audioId, sourceTime);
          }
        }

        const frame = buffer.getFrame(sourceTime);
        if (frame) this.frames.set(flat.clip, frame);
      } else {
        // Clip no longer active — stop audio but keep buffer (it may still be in window)
        if (this.playingClips.has(flat.clip)) {
          this.playingClips.delete(flat.clip);
          if (flat.audioId) this.audioScheduler?.stopClip(flat.audioId);
        }
        this.frames.delete(flat.clip);
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
    if (child.type === "clip") {
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
    } else if (child.type === "composition" || child.type === "overlay") {
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
