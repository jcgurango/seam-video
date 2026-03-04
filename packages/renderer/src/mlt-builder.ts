import type {
  ResolvedTimeline,
  ResolvedChild,
  ResolvedClip,
} from "@seam/core";
import { secondsToFrames } from "./frame-utils.js";

export interface MltProducer {
  id: string;
  resource: string;
}

export interface MltEntry {
  producer: string;
  inFrame: number;
  outFrame: number;
}

export interface MltBlank {
  length: number; // in frames
}

export type MltPlaylistItem = MltEntry | MltBlank;

export interface MltDocument {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  producers: MltProducer[];
  playlist: MltPlaylistItem[];
}

export function isEntry(item: MltPlaylistItem): item is MltEntry {
  return "producer" in item;
}

export function isBlank(item: MltPlaylistItem): item is MltBlank {
  return "length" in item && !("producer" in item);
}

export interface MltOptions {
  fps?: number;
  width?: number;
  height?: number;
}

export function buildMlt(
  timeline: ResolvedTimeline,
  optionsOrFps: number | MltOptions = {}
): MltDocument {
  const opts: MltOptions = typeof optionsOrFps === "number"
    ? { fps: optionsOrFps }
    : optionsOrFps;
  const fps = opts.fps ?? 30;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const producers: MltProducer[] = [];
  const producerMap = new Map<string, string>();
  const playlist: MltPlaylistItem[] = [];

  let currentTime = 0; // in frames

  for (const child of timeline.children) {
    const startFrame = secondsToFrames(child.timelineStart, fps);
    const endFrame = secondsToFrames(child.timelineEnd, fps);

    // Insert blank if there's a gap
    if (startFrame > currentTime) {
      playlist.push({ length: startFrame - currentTime });
    }

    if (child.type === "clip") {
      const clip = child as ResolvedClip;
      const producerId = getOrCreateProducer(
        clip,
        producers,
        producerMap,
        fps
      );

      const inFrame = secondsToFrames(clip.sourceIn, fps);
      const outFrame = secondsToFrames(clip.sourceOut, fps) - 1; // MLT out is inclusive

      playlist.push({
        producer: producerId,
        inFrame,
        outFrame,
      });
    } else {
      // Empty segment = blank
      playlist.push({ length: endFrame - startFrame });
    }

    currentTime = endFrame;
  }

  const totalFrames = secondsToFrames(timeline.duration, fps);
  return { fps, width, height, totalFrames, producers, playlist };
}

function getOrCreateProducer(
  clip: ResolvedClip,
  producers: MltProducer[],
  producerMap: Map<string, string>,
  fps: number
): string {
  const resource =
    clip.speed !== 1
      ? `timewarp:${clip.speed}:${clip.source}`
      : clip.source;

  const key = resource;
  if (producerMap.has(key)) {
    return producerMap.get(key)!;
  }

  const id = `producer${producers.length}`;
  producers.push({ id, resource });
  producerMap.set(key, id);
  return id;
}
