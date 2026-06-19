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

// End-to-end check of composition `volume`: render the OfflineAudioContext mix
// and confirm the actual output amplitude scales by the (nested) comp volume.

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

async function peak(doc: Composition, basePath: string): Promise<number> {
  const timeline = resolve(doc);
  const buf = await renderAudioMix(timeline, basePath, timeline.duration);
  if (!buf) return 0;
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  }
  return p;
}

describe("renderAudioMix — composition volume", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "seam-vol-"));
    writeSineWav(join(dir, "tone.wav"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const audioChild = { type: "audio" as const, source: "tone.wav", in: 0, out: 1 };

  it("scales clip amplitude by an enclosing composition's volume", async () => {
    const base = await peak(
      { type: "composition", children: [{ type: "composition", children: [audioChild] }] },
      dir,
    );
    const halved = await peak(
      { type: "composition", children: [{ type: "composition", volume: 0.5, children: [audioChild] }] },
      dir,
    );
    expect(base).toBeGreaterThan(0.1);
    expect(halved / base).toBeCloseTo(0.5, 1);
  });

  it("multiplies nested composition volumes", async () => {
    const base = await peak(
      { type: "composition", children: [{ type: "composition", children: [audioChild] }] },
      dir,
    );
    const quartered = await peak(
      {
        type: "composition",
        volume: 0.5, // root
        children: [{ type: "composition", volume: 0.5, children: [audioChild] }],
      },
      dir,
    );
    expect(quartered / base).toBeCloseTo(0.25, 1);
  });

  it("composes comp volume with the clip's own volume", async () => {
    const base = await peak(
      { type: "composition", children: [{ type: "composition", children: [audioChild] }] },
      dir,
    );
    const both = await peak(
      {
        type: "composition",
        children: [
          { type: "composition", volume: 0.5, children: [{ ...audioChild, volume: 0.5 }] },
        ],
      },
      dir,
    );
    expect(both / base).toBeCloseTo(0.25, 1);
  });
});
