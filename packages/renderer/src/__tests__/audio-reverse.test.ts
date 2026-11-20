import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSeamFile,
  compileSeamFile,
  resolveComposition,
  type Composition,
} from "@seam/core";
import { renderAudioMix } from "../audio.js";

// Reverse playback in the offline mix (`out < in` / negative `duration`). The
// source is a 1 s linear ramp (sample value = 0.8 · t), so the value heard at
// any output instant names the source time that produced it.

const SR = 48000;
const AMP = 0.8;

function writeRampWav(path: string): void {
  const n = SR;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((i / n) * AMP * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}

async function mix(doc: Composition, basePath: string): Promise<(t: number) => number> {
  const r = parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  const timeline = resolveComposition(compileSeamFile(r.data).doc);
  const buf = await renderAudioMix(timeline, basePath, timeline.duration);
  if (!buf) throw new Error("no audio");
  const d = buf.getChannelData(0);
  return (t) => d[Math.round(t * buf.sampleRate)];
}

describe("renderAudioMix — reverse", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "seam-reverse-"));
    writeRampWav(join(dir, "ramp.wav"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const root = (children: Composition["children"]): Composition => ({
    type: "composition",
    children,
  });

  it("out < in plays the region back to front", async () => {
    const at = await mix(root([{ type: "audio", source: "ramp.wav", in: 1, out: 0 }]), dir);
    // Output t hears source 1 − t.
    expect(at(0.1)).toBeCloseTo(AMP * 0.9, 2);
    expect(at(0.5)).toBeCloseTo(AMP * 0.5, 2);
    expect(at(0.9)).toBeCloseTo(AMP * 0.1, 2);
  });

  it("negative duration is the same thing", async () => {
    const at = await mix(root([{ type: "audio", source: "ramp.wav", in: 0.75, duration: -0.5 }]), dir);
    // Plays 0.75 → 0.25.
    expect(at(0.1)).toBeCloseTo(AMP * 0.65, 2);
    expect(at(0.4)).toBeCloseTo(AMP * 0.35, 2);
  });

  it("speed scales the reversed playback", async () => {
    const at = await mix(root([{ type: "audio", source: "ramp.wav", in: 1, out: 0, speed: 2 }]), dir);
    // 0.5 s long; output t hears source 1 − 2t.
    expect(at(0.1)).toBeCloseTo(AMP * 0.8, 2);
    expect(at(0.4)).toBeCloseTo(AMP * 0.2, 2);
  });

  it("a reversed loop restarts from the high end each cycle", async () => {
    const at = await mix(
      root([
        { type: "audio", source: "ramp.wav", in: 0.75, out: 0.25, duration: 1.25, underflow: "loop" },
      ]),
      dir,
    );
    // Cycle = 0.5 s, each playing 0.75 → 0.25.
    expect(at(0.1)).toBeCloseTo(AMP * 0.65, 2);
    expect(at(0.6)).toBeCloseTo(AMP * 0.65, 2);
    expect(at(1.1)).toBeCloseTo(AMP * 0.65, 2);
    expect(at(0.9)).toBeCloseTo(AMP * 0.35, 2);
  });

  it("a region running past the file's end leads with silence", async () => {
    const at = await mix(root([{ type: "audio", source: "ramp.wav", in: 1.5, out: 0.5 }]), dir);
    // Source 1.5 → 1.0 doesn't exist; then 1.0 → 0.5.
    expect(Math.abs(at(0.25))).toBeLessThan(0.01);
    expect(at(0.75)).toBeCloseTo(AMP * 0.75, 2);
  });
});
