import type { ResolvedChild, ResolvedClip, ResolvedTimeline } from "@seam/core";
import { AudioBufferSink } from "mediabunny";
import { ClipPlayer } from "./ClipPlayer.js";
import { MediaStore } from "./MediaStore.js";
import { AudioScheduler } from "./AudioScheduler.js";
import { resolveSource } from "../components/resolveSource.js";

const LOOKAHEAD = 1; // seconds

interface FlatClip {
  clip: ResolvedClip;
  absoluteStart: number;
  absoluteEnd: number;
  source: string;
  audioId: string | null; // null if no audio
  toSourceTime: (absoluteTime: number) => number;
}

export class FrameCoordinator {
  private players = new Map<ResolvedClip, ClipPlayer>();
  private flatClips: FlatClip[] = [];
  private frames = new Map<ResolvedClip, HTMLCanvasElement | OffscreenCanvas>();
  private sizes = new Map<ResolvedClip, { w: number; h: number }>();
  private playingClips = new Set<ResolvedClip>();
  private primedClips = new Set<ResolvedClip>();
  private audioScheduler: AudioScheduler | null = null;
  private ready = false;

  /** Called when an async seek completes and a new frame is available (for re-render). */
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

    // Set AudioContext sample rate from the first audio track
    for (const flat of this.flatClips) {
      const audioTrack = await mediaStore.getAudioTrack(flat.source);
      if (audioTrack && (await audioTrack.canDecode())) {
        audioScheduler.setSampleRate(audioTrack.sampleRate);
        break;
      }
    }

    const initAll = this.flatClips.map(async (flat) => {
      const player = new ClipPlayer();
      this.players.set(flat.clip, player);

      await player.init(mediaStore, flat.source);

      const size = await mediaStore.getIntrinsicSize(flat.source);
      if (size.w > 0) this.sizes.set(flat.clip, size);

      // Register audio
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

    // Seek to start so the first frame is visible immediately
    this.onSeek(0, timeline.duration, false);
  }

  tick(currentTime: number, isPlaying: boolean, duration: number, loop: boolean): void {
    if (!this.ready) return;

    for (const flat of this.flatClips) {
      const player = this.players.get(flat.clip);
      if (!player) continue;

      const isActive = currentTime >= flat.absoluteStart && currentTime < flat.absoluteEnd;
      const isUpcoming = !isActive && this.isUpcoming(flat, currentTime, duration, loop);

      if (isActive) {
        const sourceTime = flat.toSourceTime(currentTime);

        // Start video + audio if this clip just became active during playback
        if (isPlaying && !this.playingClips.has(flat.clip)) {
          this.playingClips.add(flat.clip);
          this.primedClips.delete(flat.clip);
          void player.startPlayback(sourceTime);
          if (flat.audioId) {
            this.audioScheduler?.startClip(flat.audioId, sourceTime);
          }
        }

        // Advance frame
        const frame = player.getFrame(sourceTime);
        if (frame) {
          this.frames.set(flat.clip, frame);
        }
      } else {
        // Clip is no longer active — clean up
        if (this.playingClips.has(flat.clip)) {
          this.playingClips.delete(flat.clip);
          // Let audio finish naturally (stopClip kills iterator but lets queued nodes play out)
          if (flat.audioId) {
            this.audioScheduler?.stopClip(flat.audioId);
          }
        }
        this.frames.delete(flat.clip);

        // Prime upcoming clips
        if (isUpcoming && !this.primedClips.has(flat.clip)) {
          this.primedClips.add(flat.clip);
          void player.seek(flat.clip.sourceIn);
          console.log(flat);
        }
      }
    }
  }

  onPlay(currentTime: number): void {
    if (!this.ready) return;
    // playingClips is cleared so tick() will call startPlayback + startClip for active clips
    this.playingClips.clear();
    this.primedClips.clear();
  }

  onSeek(currentTime: number, duration: number, loop: boolean): void {
    if (!this.ready) return;
    this.playingClips.clear();
    this.primedClips.clear();

    for (const flat of this.flatClips) {
      const player = this.players.get(flat.clip);
      if (!player) continue;

      const isActive = currentTime >= flat.absoluteStart && currentTime < flat.absoluteEnd;

      if (isActive) {
        const sourceTime = flat.toSourceTime(currentTime);
        void player.seek(sourceTime).then(() => {
          const frame = player.getFrame(sourceTime);
          if (frame) {
            this.frames.set(flat.clip, frame);
            this.onFrameAvailable?.();
          }
        });
      } else if (this.isUpcoming(flat, currentTime, duration, loop)) {
        this.primedClips.add(flat.clip);
        void player.seek(flat.clip.sourceIn);
      }
    }
  }

  getFrame(clip: ResolvedClip): HTMLCanvasElement | OffscreenCanvas | null {
    return this.frames.get(clip) ?? null;
  }

  getIntrinsicSize(clip: ResolvedClip): { w: number; h: number } | null {
    return this.sizes.get(clip) ?? null;
  }

  dispose(): void {
    for (const player of this.players.values()) {
      player.dispose();
    }
    this.players.clear();
    this.flatClips = [];
    this.frames.clear();
    this.sizes.clear();
    this.playingClips.clear();
    this.primedClips.clear();
    this.ready = false;
  }

  private isUpcoming(
    flat: FlatClip,
    currentTime: number,
    duration: number,
    loop: boolean
  ): boolean {
    const timeUntilStart = flat.absoluteStart - currentTime;
    if (timeUntilStart > 0 && timeUntilStart <= LOOKAHEAD) return true;

    // Loop wraparound: prime clips near t=0 when we're near the end
    if (loop && currentTime + LOOKAHEAD >= duration) {
      const wrappedLookahead = (currentTime + LOOKAHEAD) - duration;
      if (flat.absoluteStart <= wrappedLookahead) return true;
    }

    return false;
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
