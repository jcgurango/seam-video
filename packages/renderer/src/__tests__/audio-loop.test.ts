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

// `underflow: "loop"` in the offline mix: a 1s tone anchored over a 3.5s span
// must sound for the whole span (each cycle is its own buffer-source slice),
// and a looping composition's inner audio replays the same way.

const SR = 48000;

/** 1s mono 16-bit PCM sine WAV (mediabunny decodes WAV). */
function writeSineWav(path: string, freq = 440, amp = 0.8, seconds = 1): void {
  const n = SR * seconds;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
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

/** RMS of the mixed output over [a, b) seconds. */
async function rmsWindows(
  doc: Composition,
  basePath: string,
  windows: [number, number][],
): Promise<number[]> {
  const timeline = resolve(doc);
  const buf = await renderAudioMix(timeline, basePath, timeline.duration);
  if (!buf) return windows.map(() => 0);
  const d = buf.getChannelData(0);
  return windows.map(([a, b]) => {
    const i0 = Math.floor(a * buf.sampleRate);
    const i1 = Math.min(d.length, Math.floor(b * buf.sampleRate));
    let acc = 0;
    for (let i = i0; i < i1; i++) acc += d[i] * d[i];
    return Math.sqrt(acc / Math.max(1, i1 - i0));
  });
}

/** Start with `id` and fill 3.5s (the bed's length) — `underflow` says how. */
const over = (id: string) => ({ start: id, duration: 3.5 });

describe("renderAudioMix — underflow: loop", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "seam-loop-"));
    writeSineWav(join(dir, "tone.wav"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const bed = { id: "bed", type: "data" as const, data: null, duration: 3.5 };

  it("a looping audio node sounds across the whole anchored span", async () => {
    const doc: Composition = {
      type: "composition",
      children: [
        bed,
        { type: "audio", source: "tone.wav", in: 0, out: 1, underflow: "loop", ...over("bed") },
      ],
    };
    const [c0, c1, c2, tail] = await rmsWindows(doc, dir, [
      [0.1, 0.9],
      [1.1, 1.9],
      [2.1, 2.9],
      [3.1, 3.45],
    ]);
    // A 0.8-amplitude sine has RMS ≈ 0.566. Every cycle, incl. the cut-short
    // last one, carries it.
    for (const v of [c0, c1, c2, tail]) expect(v).toBeGreaterThan(0.5);
  });

  it("without loop the default stretch slows the tone instead", async () => {
    const doc: Composition = {
      type: "composition",
      children: [
        bed,{ type: "audio", source: "tone.wav", in: 0, out: 1, ...over("bed") }],
    };
    // Stretched to 3.5s at 1/3.5 rate: still sounds throughout (sanity that
    // the span is covered either way) — the loop test above is what pins the
    // new behaviour; here we just make sure nothing regressed.
    const [a, b] = await rmsWindows(doc, dir, [[0.1, 0.9], [3.0, 3.4]]);
    expect(a).toBeGreaterThan(0.3);
    expect(b).toBeGreaterThan(0.3);
  });

  it("a looping composition replays its inner audio each cycle", async () => {
    const doc: Composition = {
      type: "composition",
      children: [
        bed,
        {
          type: "composition",
          underflow: "loop",
          children: [
            { type: "audio", source: "tone.wav", in: 0, out: 0.5 },
            { type: "data", data: null, duration: 0.5 },
          ],
          ...over("bed"),
        },
      ],
    };
    // Cycle = 1s: tone in the first half, silence in the second — in EVERY
    // cycle, including the partial fourth (3.0–3.5 is a tone half).
    const [t0, s0, t2, s2, t3] = await rmsWindows(doc, dir, [
      [0.05, 0.45],
      [0.55, 0.95],
      [2.05, 2.45],
      [2.55, 2.95],
      [3.05, 3.45],
    ]);
    expect(t0).toBeGreaterThan(0.5);
    expect(s0).toBeLessThan(0.01);
    expect(t2).toBeGreaterThan(0.5);
    expect(s2).toBeLessThan(0.01);
    expect(t3).toBeGreaterThan(0.5);
  });

  it("the looping node's keyframed volume runs over the full span", async () => {
    const doc: Composition = {
      type: "composition",
      children: [
        bed,
        {
          type: "audio",
          source: "tone.wav",
          in: 0,
          out: 1,
          underflow: "loop",
          volume: [[0, 1], [3.5, 0]],
          ...over("bed"),
        },
      ],
    };
    const [early, late] = await rmsWindows(doc, dir, [[0.1, 0.4], [3.0, 3.3]]);
    // A per-cycle envelope would restart at full volume every second; over
    // the node span the last cycle is nearly silent.
    expect(early).toBeGreaterThan(0.45);
    expect(late).toBeLessThan(0.12);
  });
});
