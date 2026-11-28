import { describe, it, expect, afterAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerMediabunnyServer } from "@mediabunny/server";
import { Input, FilePathSource, VideoSampleSink, ALL_FORMATS } from "mediabunny";
import { HdrToSdrConverter, isHdrSample, tonemapToRgba, type YuvPicture } from "../hdrToSdr.js";

// HDR input footage (HLG / PQ) must reach the compositor tone-mapped to SDR
// BT.709 — the preview gets that from Chromium, the renderer from its own
// pure-TypeScript tone-mapper (see hdrToSdr.ts), so it behaves the same on
// every platform and needs nothing from the bundled FFmpeg's filter set.
//
// Fixtures: 64×64, 3 frames, lossless x265, 10-bit limited-range grey
// (Y = code, Cb = Cr = 512) tagged bt2020 + the transfer in the name:
//
//   ffmpeg -f lavfi -i "color=c=gray:s=64x64:r=30:d=0.1,format=yuv420p10le,geq=lum=<Y>:cb=512:cr=512" //     -c:v libx265 -preset ultrafast //     -x265-params "lossless=1:colorprim=bt2020:transfer=<arib-std-b67|smpte2084>:colormatrix=bt2020nc:range=limited" //     -color_primaries bt2020 -color_trc <arib-std-b67|smpte2084> -colorspace bt2020nc -color_range tv //     -tag:v hvc1 <name>.mp4
//
// The expected greys are the look we validated: they were MEASURED from the
// jellyfin-ffmpeg `tonemapx` filter this module replaced (hable, 1000-nit
// peak; HLG via the standard OOTF γ=1.2 with 75% signal = scene white) and
// our port reproduces them. They are the tripwire for the look of every HDR
// render — a change to the curve fails here instead of surfacing as "footage
// looks off".
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
// LUT quantisation + rounding. (The filter needed 3: it went through 8-bit YUV.)
const TOLERANCE = 1;

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
      // Two frames through one instance: exercises scratch-buffer reuse.
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

// The conversion itself, on synthetic planes — no decoder involved.
describe("tonemapToRgba", () => {
  /** A flat picture: every pixel (Y, Cb, Cr) in `depth`-bit codes. */
  function flat(
    yuv: [number, number, number],
    over: Partial<YuvPicture> = {},
  ): YuvPicture {
    const width = over.width ?? 4;
    const height = over.height ?? 4;
    const subX = over.subX ?? 1;
    const subY = over.subY ?? 1;
    const cw = (width + subX) >> subX;
    const ch = (height + subY) >> subY;
    return {
      width,
      height,
      depth: 10,
      subX,
      subY,
      y: new Uint16Array(width * height).fill(yuv[0]),
      u: new Uint16Array(cw * ch).fill(yuv[1]),
      v: new Uint16Array(cw * ch).fill(yuv[2]),
      yStride: width,
      uStride: cw,
      vStride: cw,
      transfer: "hlg",
      primaries: "bt2020",
      matrix: "bt2020-ncl",
      fullRange: false,
      ...over,
    };
  }
  const px = (rgba: Uint8Array, i = 0) => Array.from(rgba.subarray(i * 4, i * 4 + 4));

  it("maps black to black and keeps alpha opaque", () => {
    expect(px(tonemapToRgba(flat([64, 512, 512])))).toEqual([0, 0, 0, 255]);
  });

  it("gives the same grey at any bit depth, range and subsampling", () => {
    const ref = px(tonemapToRgba(flat([720, 512, 512])));
    expect(ref).toEqual([158, 158, 158, 255]);
    const variants: YuvPicture[] = [
      // 12-bit limited: codes × 4.
      { ...flat([2880, 2048, 2048]), depth: 12 },
      // Full range: Y = 0.7489 × 1023.
      flat([766, 512, 512], { fullRange: true }),
      flat([720, 512, 512], { subX: 1, subY: 0 }),
      flat([720, 512, 512], { subX: 0, subY: 0 }),
      // Odd dimensions: the last luma column/row shares a chroma sample.
      flat([720, 512, 512], { width: 5, height: 3 }),
    ];
    for (const v of variants) {
      const out = tonemapToRgba(v);
      expect(out.length).toBe(v.width * v.height * 4);
      for (let i = 0; i < v.width * v.height; i++) {
        for (const c of [0, 1, 2]) expect(Math.abs(out[i * 4 + c]! - 158)).toBeLessThanOrEqual(1);
        expect(out[i * 4 + 3]).toBe(255);
      }
    }
  });

  it("is monotonic in luma and never exceeds white", () => {
    let prev = -1;
    for (let y = 64; y <= 1023; y += 7) {
      const [r] = px(tonemapToRgba(flat([y, 512, 512])));
      expect(r!).toBeGreaterThanOrEqual(prev);
      prev = r!;
    }
    expect(prev).toBeLessThanOrEqual(255);
  });

  it("resolves shadows without the coarse steps of a linear-indexed LUT", () => {
    // Near black, consecutive 10-bit codes must not jump by several 8-bit
    // codes (tonemapx's 15-bit linear output LUT started 0 → 3).
    let prev = px(tonemapToRgba(flat([64, 512, 512])))[0]!;
    for (let y = 65; y <= 140; y++) {
      const r = px(tonemapToRgba(flat([y, 512, 512])))[0]!;
      expect(r - prev, `Y=${y}`).toBeLessThanOrEqual(1);
      prev = r;
    }
    expect(prev).toBeGreaterThan(5);
  });

  it("converts BT.2020 primaries to BT.709 and honours the tags", () => {
    // BT.2020 pure red at 50% signal, limited range (Kr=.2627, Kb=.0593).
    const red: [number, number, number] = [
      Math.round(64 + 876 * 0.5 * 0.2627),
      Math.round(512 + 896 * ((0 - 0.5 * 0.2627) / 1.8814)),
      Math.round(512 + 896 * ((0.5 - 0.5 * 0.2627) / 1.4746)),
    ];
    const [r, g, b] = px(tonemapToRgba(flat(red)));
    // Out of the BT.709 gamut: red stays, green/blue clip to (near) zero.
    expect(r!).toBeGreaterThan(90);
    expect(g!).toBeLessThanOrEqual(3);
    expect(b!).toBeLessThanOrEqual(3);
    // The same codes read as BT.709 primaries skip the gamut matrix, so the
    // red comes out less saturated-bright than the widened one.
    const [r709] = px(tonemapToRgba(flat(red, { primaries: "bt709" })));
    expect(r709!).toBeLessThan(r!);
  });

  it("uses per-block chroma for 4:2:0", () => {
    // 4×2 picture, two chroma samples: left neutral, right pushed to red.
    const pic = flat([502, 512, 512], { width: 4, height: 2 });
    (pic.v as Uint16Array)[1] = 700;
    const out = tonemapToRgba(pic);
    for (const i of [0, 1, 4, 5]) expect(px(out, i)[0]).toBe(px(out, i)[2]);
    for (const i of [2, 3, 6, 7]) expect(px(out, i)[0]!).toBeGreaterThan(px(out, i)[2]! + 20);
  });

  it("writes into a supplied buffer", () => {
    const pic = flat([720, 512, 512]);
    const buf = new Uint8Array(pic.width * pic.height * 4);
    expect(tonemapToRgba(pic, buf)).toBe(buf);
    expect(px(buf)).toEqual([158, 158, 158, 255]);
  });
});
