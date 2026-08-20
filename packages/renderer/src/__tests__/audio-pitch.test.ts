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

// End-to-end check of `pitch`: render the OfflineAudioContext mix of a 440Hz
// sine and confirm the output's spectral peak moves to the shifted frequency
// while the clip still fills its full output span (length-preserving).

const SR = 48000;

/** Write a 1s mono 16-bit PCM sine WAV (mediabunny decodes WAV). */
function writeSineWav(path: string, freq = 440, amp = 0.8, seconds = 1): void {
  const n = SR * seconds;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function resolve(doc: Composition) {
  const r = parseSeamFile(JSON.stringify(doc));
  if (!r.success) throw new Error(r.errors.join(", "));
  return resolveComposition(compileSeamFile(r.data).doc);
}

async function mix(doc: Composition, basePath: string): Promise<Float32Array> {
  const timeline = resolve(doc);
  const buf = await renderAudioMix(timeline, basePath, timeline.duration);
  if (!buf) throw new Error("no audio rendered");
  return Float32Array.from(buf.getChannelData(0));
}

/** Goertzel magnitude of `freq` over samples [from, to). */
function tone(data: Float32Array, freq: number, from: number, to: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s0 = 0,
    s1 = 0,
    s2 = 0;
  for (let i = from; i < to; i++) {
    s0 = data[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (to - from);
}

/** Peak |sample| over [from, to). */
function peakIn(data: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(data[i]));
  return p;
}

describe("renderAudioMix — pitch", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "seam-pitch-"));
    writeSineWav(join(dir, "tone.wav"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const audioChild = { type: "audio" as const, source: "tone.wav", in: 0, out: 1 };
  // Analysis window: mid-clip, clear of the shifter's onset latency and tail.
  const FROM = Math.round(0.3 * SR);
  const TO = Math.round(0.8 * SR);

  it("shifts +12 semitones to double frequency, preserving length", async () => {
    const data = await mix(
      { type: "composition", children: [{ ...audioChild, pitch: 12 }] },
      dir,
    );
    const at880 = tone(data, 880, FROM, TO);
    const at440 = tone(data, 440, FROM, TO);
    expect(at880).toBeGreaterThan(0.05);
    expect(at880 / Math.max(at440, 1e-9)).toBeGreaterThan(4);
    // Length-preserving: still audible near the end of the 1s span (a plain
    // 2× playbackRate would have exhausted the source at 0.5s).
    expect(peakIn(data, Math.round(0.85 * SR), Math.round(0.95 * SR))).toBeGreaterThan(0.1);
  });

  it("shifts −12 semitones to half frequency", async () => {
    const data = await mix(
      { type: "composition", children: [{ ...audioChild, pitch: -12 }] },
      dir,
    );
    const at220 = tone(data, 220, FROM, TO);
    const at440 = tone(data, 440, FROM, TO);
    expect(at220).toBeGreaterThan(0.05);
    expect(at220 / Math.max(at440, 1e-9)).toBeGreaterThan(4);
  });

  it("adds composition pitch to the clip's own (7 + 5 = +12)", async () => {
    const data = await mix(
      {
        type: "composition",
        children: [
          { type: "composition", pitch: 7, children: [{ ...audioChild, pitch: 5 }] },
        ],
      },
      dir,
    );
    const at880 = tone(data, 880, FROM, TO);
    const at440 = tone(data, 440, FROM, TO);
    expect(at880 / Math.max(at440, 1e-9)).toBeGreaterThan(4);
  });

  it("leaves unpitched audio untouched", async () => {
    const data = await mix(
      { type: "composition", children: [audioChild] },
      dir,
    );
    const at440 = tone(data, 440, FROM, TO);
    const at880 = tone(data, 880, FROM, TO);
    expect(at440).toBeGreaterThan(0.2);
    expect(at440 / Math.max(at880, 1e-9)).toBeGreaterThan(10);
  });
});
