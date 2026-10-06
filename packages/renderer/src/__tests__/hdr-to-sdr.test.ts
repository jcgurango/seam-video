import { describe, it, expect, afterAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, FilePathSource, VideoSampleSink, ALL_FORMATS } from "mediabunny";
import { HdrToSdrConverter, isHdrSample } from "../hdrToSdr.js";

// HDR input footage (HLG / PQ) must reach the compositor tone-mapped to SDR
// BT.709 — the preview gets that from Chromium, the renderer from the
// jellyfin-ffmpeg `tonemapx` filter bundled in node-av (see hdrToSdr.ts).
//
// Fixtures: 64×64, 3 frames, lossless x265, 10-bit limited-range grey
// (Y = code, Cb = Cr = 512) tagged bt2020 + the transfer in the name:
//
//   ffmpeg -f lavfi -i "color=c=gray:s=64x64:r=30:d=0.1,format=yuv420p10le,geq=lum=<Y>:cb=512:cr=512" \
//     -c:v libx265 -preset ultrafast \
//     -x265-params "lossless=1:colorprim=bt2020:transfer=<arib-std-b67|smpte2084>:colormatrix=bt2020nc:range=limited" \
//     -color_primaries bt2020 -color_trc <arib-std-b67|smpte2084> -colorspace bt2020nc -color_range tv \
//     -tag:v hvc1 <name>.mp4
//
// Expected greys are MEASURED from the bundled filter, then checked against
// a model of its source: PQ (573 ≈ 203 nit) matches the model exactly; the
// HLG points fit the standard HLG OOTF (γ=1.2, 75% signal normalised to
// scene white) — not the BT.2446-B variant in jellyfin-ffmpeg master. The
// curve therefore depends on which jellyfin revision node-av bundles, and
// these numbers are the tripwire: a node-av bump that changes the look of
// every HDR render fails here instead of surfacing as "footage looks off".
//
//   HLG signal   0.25 → 48    0.50 → 94    0.75 → 158    1.00 → 243
//   PQ 203 nit                              → 173

registerMediabunnyServer();

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", `${name}.mp4`);
const CASES: { name: string; transfer: string; grey: number }[] = [
  { name: "hlg-283", transfer: "hlg", grey: 48 },
  { name: "hlg-502", transfer: "hlg", grey: 94 },
  { name: "hlg-720", transfer: "hlg", grey: 158 },
  { name: "hlg-940", transfer: "hlg", grey: 243 },
  { name: "pq-573", transfer: "pq", grey: 173 },
];
// 15-bit LUT quantisation + 10→8-bit YUV→RGB rounding.
const TOLERANCE = 3;

const inputs: Input[] = [];
afterAll(() => {
  for (const i of inputs) i.dispose();
});

async function openSink(name: string): Promise<VideoSampleSink> {
  const input = new Input({ source: new FilePathSource(fixture(name)), formats: ALL_FORMATS });
  inputs.push(input);
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`${name}: no video track`);
  return new VideoSampleSink(track);
}

describe("HDR → SDR input conversion", () => {
  it("detects HLG and PQ-tagged samples", async () => {
    for (const c of CASES) {
      const sample = await (await openSink(c.name)).getSample(0);
      expect(sample, c.name).not.toBeNull();
      expect(sample!.colorSpace.transfer, c.name).toBe(c.transfer);
      expect(sample!.colorSpace.primaries, c.name).toBe("bt2020");
      expect(isHdrSample(sample!), c.name).toBe(true);
      sample!.close();
    }
  });

  it.each(CASES)("tone-maps $name to grey $grey", async ({ name, grey }) => {
    const sink = await openSink(name);
    const conv = new HdrToSdrConverter();
    try {
      // Two frames through one instance: exercises graph reuse.
      for (let i = 0; i < 2; i++) {
        const sample = await sink.getSample(i / 30);
        expect(sample).not.toBeNull();
        const rgba = await conv.toRgba(sample!);
        sample!.close();
        expect(rgba.length).toBe(64 * 64 * 4);
        // Centre + corners (chroma block edges included).
        for (const [x, y] of [[32, 32], [0, 0], [63, 63]] as const) {
          const o = (y * 64 + x) * 4;
          for (const ch of [0, 1, 2]) {
            expect(Math.abs(rgba[o + ch]! - grey), `${name} @${x},${y} ch${ch}=${rgba[o + ch]}`)
              .toBeLessThanOrEqual(TOLERANCE);
          }
          expect(rgba[o + 3]).toBe(255);
        }
      }
    } finally {
      conv.dispose();
    }
  });

  it("is a visible change versus the untouched RGBA path", async () => {
    // Control: mediabunny's plain conversion treats the HLG 75% code as
    // ordinary gamma video and lands far from the tone-mapped value. If this
    // ever converges, the converter has silently stopped doing anything.
    const sample = await (await openSink("hlg-720")).getSample(0);
    const raw = new Uint8Array(sample!.allocationSize({ format: "RGBA" }));
    await sample!.copyTo(raw, { format: "RGBA" });
    sample!.close();
    const o = (32 * 64 + 32) * 4;
    expect(Math.abs(raw[o]! - 158)).toBeGreaterThan(20);
  });
});
