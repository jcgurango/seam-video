import { describe, it, expect } from "vitest";
import {
  resolveComposition,
  resolveSpatial,
  type Composition,
  type ResolvedTimeline,
} from "@seam/core";
import { buildMltDocument } from "../mlt-builder.js";
import { buildFfmpegAudioCommand } from "../ffmpeg-audio.js";

function resolve(doc: Composition): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  const w = (temporal.contentWidth as number) ?? 1080;
  const h = (temporal.contentHeight as number) ?? 1920;
  return resolveSpatial(temporal, w, h);
}

/** Overlay transition blocks (skip the track-0 video-fill transition). */
function overlays(xml: string): string[] {
  return [...xml.matchAll(/<transition>[\s\S]*?<\/transition>/g)]
    .map((m) => m[0])
    .filter((t) => t.includes('name="in"'));
}

describe("crossfade (transition) → MLT video", () => {
  const doc: Composition = {
    type: "composition",
    contentWidth: 320,
    contentHeight: 240,
    children: [
      { type: "clip", source: "a.mp4", in: 0, out: 2 },
      { type: "clip", source: "b.mp4", in: 0, out: 2, transition: 1 },
    ],
  };

  it("puts the crossfading clip on its own track with a fade-in alpha ramp", () => {
    const { xml } = buildMltDocument(resolve(doc), {
      width: 320,
      height: 240,
      fps: 30,
    });
    // The incoming clip B gets an overlay (own track) — the outgoing A stays
    // on the shared video playlist, so there's exactly one overlay here.
    const ov = overlays(xml);
    expect(ov.length).toBe(1);
    const rect = ov[0].match(/<property name="rect">([^<]+)<\/property>/)![1];
    // Keyframed alpha: starts at 0, climbs to 1 over the 1s (30-frame)
    // overlap, then holds at 1.
    expect(rect).toContain(";"); // multiple keyframes
    expect(rect).toMatch(/^0=[^;]* 0(;|$)/); // first keyframe alpha 0
    const lastAlpha = Number(rect.split(";").at(-1)!.trim().split(" ").at(-1));
    expect(lastAlpha).toBe(1);
  });

  it("does not add an overlay/fade when there's no transition", () => {
    const plain: Composition = {
      type: "composition",
      contentWidth: 320,
      contentHeight: 240,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 2 },
        { type: "clip", source: "b.mp4", in: 0, out: 2 },
      ],
    };
    const { xml } = buildMltDocument(resolve(plain), { width: 320, height: 240, fps: 30 });
    expect(overlays(xml).length).toBe(0);
  });
});

describe("crossfade (transition) → ffmpeg audio", () => {
  it("fades the incoming clip in and the outgoing clip out", () => {
    const doc: Composition = {
      type: "composition",
      children: [
        { type: "audio", source: "a.wav", in: 0, out: 2 },
        { type: "audio", source: "b.wav", in: 0, out: 2, transition: 1 },
      ],
    };
    const cmd = buildFfmpegAudioCommand(resolve(doc), "/tmp/out.m4a", { fps: 30 });
    // Incoming B fades in; outgoing A fades out — both over the 1s overlap.
    expect(cmd.filterComplex).toContain("afade=t=in:st=0:d=1");
    expect(cmd.filterComplex).toMatch(/afade=t=out:st=1:d=1/);
  });
});
