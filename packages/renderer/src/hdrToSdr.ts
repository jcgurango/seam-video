/**
 * HDR → SDR input conversion for the headless renderer.
 *
 * The preview gets this for free: Chromium's WebCodecs → WebGPU upload honours
 * a frame's colour tags and tone-maps HLG/PQ to sRGB. The renderer's decode
 * goes through mediabunny's swscale RGBA conversion, which ignores transfer,
 * primaries and tone mapping entirely, so HDR clips came out flat and
 * desaturated. This module is seam's opinionated default for that gap: any
 * sample tagged HLG or PQ is tone-mapped here, in plain TypeScript, straight
 * from its decoded Y'CbCr planes to SDR BT.709 RGBA. SDR samples are untouched.
 *
 * It is a port of the scalar path of jellyfin-ffmpeg's `tonemapx` filter
 * (`tonemap=hable:desat=0:peak=100`, the chain we validated visually against
 * Apple's avconvert). We used to run that filter itself through node-av, but
 * only node-av's macOS/Linux/MinGW binaries bundle the Jellyfin FFmpeg — the
 * MSVC build stock Windows Node loads is vanilla FFmpeg with no `tonemapx`.
 * Owning the maths makes the look identical on every platform and immune to
 * FFmpeg revisions (jellyfin master has since moved HLG to BT.2446-B).
 *
 * The pipeline, per pixel:
 *   1. Y'CbCr → R'G'B' with the tagged matrix/range (BT.2020-NCL limited when
 *      untagged); chroma is nearest-upsampled, as tonemapx does.
 *   2. Linearize to 203-nit reference-white units. PQ: ST.2084 EOTF. HLG:
 *      inverse OETF, then the OOTF (γ = 1.2) applied per channel, normalised
 *      so a 75 % signal is scene white.
 *   3. BT.2020 → BT.709 primaries (3×3, linear light).
 *   4. Hable curve against a fixed 1000-nit peak, as ONE gain per pixel taken
 *      from its brightest channel — hue is preserved, nothing clips unevenly.
 *   5. Clip, 2.4 gamma (inverse BT.1886), 8-bit RGB.
 *
 * Deliberate differences from the filter: it wrote 8-bit 4:2:0 and we then
 * converted that to RGBA, costing a chroma round trip — here step 5 lands in
 * RGB directly. And its 15-bit linear-indexed output LUT is coarse in the
 * shadows (the first step is ~3 codes); ours is indexed by √linear, which is
 * smooth all the way down. Greys agree with the filter to within a code or
 * two (pinned in `__tests__/hdr-to-sdr.test.ts`).
 */
import type { VideoSample } from "mediabunny";

// ── Constants (names follow FFmpeg's libavfilter/colorspace.h) ──────────────

/** Nits that linear 1.0 stands for (BT.2408 reference white). */
const REFERENCE_WHITE = 203;
/** Every constant of the curve, for the WGSL port (`hdrToSdrGpu.ts`) — the
 *  two implementations must be the same maths. */
export const HDR_CONSTANTS = {
  get PEAK() { return PEAK; },
  get HLG_SCALE() { return 12 / REFERENCE_WHITE_HLG; },
  get HLG_GAMMA() { return HLG_GAMMA; },
  get ARIB_B67_A() { return ARIB_B67_A; },
  get ARIB_B67_B() { return ARIB_B67_B; },
  get ARIB_B67_C() { return ARIB_B67_C; },
  get ST2084_M1() { return ST2084_M1; },
  get ST2084_M2() { return ST2084_M2; },
  get ST2084_C1() { return ST2084_C1; },
  get ST2084_C2() { return ST2084_C2; },
  get ST2084_C3() { return ST2084_C3; },
  get PQ_SCALE() { return 10000 / REFERENCE_WHITE; },
  get HABLE_PEAK() { return hable(PEAK); },
};
/** Tone-mapping source peak: 1000 nits, in reference-white units. Fixed — not
 *  read from mastering metadata — so every HDR source rides one curve. */
const PEAK = 1000 / REFERENCE_WHITE;
/** 12 × the HLG scene-linear value of a 75 % signal: dividing by it puts 75 %
 *  (HLG reference white) at scene 1.0. */
const REFERENCE_WHITE_HLG = 3.17955;
const HLG_GAMMA = 1.2;
const ARIB_B67_A = 0.17883277;
const ARIB_B67_B = 0.28466892;
const ARIB_B67_C = 0.55991073;
const ST2084_M1 = 0.1593017578125;
const ST2084_M2 = 78.84375;
const ST2084_C1 = 0.8359375;
const ST2084_C2 = 18.8515625;
const ST2084_C3 = 18.6875;

/** Signal-domain LUT resolution: R'G'B' are carried as 15-bit integers. */
const SIGNAL_MAX = 32767;
/** Output LUT resolution (indexed by √linear). */
const DELIN_MAX = 4095;

export type HdrTransfer = "hlg" | "pq";

// ── Transfer curves ─────────────────────────────────────────────────────────

/** HLG signal [0,1] → display-linear, reference-white units. */
export function hlgToLinear(x: number): number {
  const scene =
    (x > 0.5 ? Math.exp((x - ARIB_B67_C) / ARIB_B67_A) + ARIB_B67_B : 4 * x * x) / 12;
  return (12 / REFERENCE_WHITE_HLG) * Math.pow(Math.max(scene, 0), HLG_GAMMA);
}

/** PQ signal [0,1] → display-linear, reference-white units. */
export function pqToLinear(x: number): number {
  const xpow = Math.pow(Math.max(x, 0), 1 / ST2084_M2);
  const num = Math.max(xpow - ST2084_C1, 0);
  const den = Math.max(ST2084_C2 - ST2084_C3 * xpow, 1e-6);
  return (Math.pow(num / den, 1 / ST2084_M1) * 10000) / REFERENCE_WHITE;
}

function hable(x: number): number {
  const a = 0.15, b = 0.5, c = 0.1, d = 0.2, e = 0.02, f = 0.3;
  return (x * (x * a + b * c) + d * e) / (x * (x * a + b) + d * f) - e / f;
}

/** Display-linear (reference-white units) → SDR linear, before clipping. */
export function tonemapLinear(sig: number): number {
  return hable(sig) / hable(PEAK);
}

interface TransferLuts {
  /** signal (15-bit) → linear light. */
  lin: Float32Array;
  /** signal (15-bit) → tone-map gain (mapped / linear) at that signal. */
  gain: Float32Array;
}

const transferLuts = new Map<HdrTransfer, TransferLuts>();

function lutsFor(transfer: HdrTransfer): TransferLuts {
  let luts = transferLuts.get(transfer);
  if (!luts) {
    const lin = new Float32Array(SIGNAL_MAX + 1);
    const gain = new Float32Array(SIGNAL_MAX + 1);
    const toLinear = transfer === "hlg" ? hlgToLinear : pqToLinear;
    for (let i = 0; i <= SIGNAL_MAX; i++) {
      const sig = Math.max(toLinear(i / SIGNAL_MAX), 0);
      const mapped = tonemapLinear(sig);
      lin[i] = sig;
      gain[i] = sig > 0 && mapped > 0 ? mapped / sig : 0;
    }
    luts = { lin, gain };
    transferLuts.set(transfer, luts);
  }
  return luts;
}

let delinLut: Uint8Array | null = null;

/** √(SDR linear) × DELIN_MAX → 8-bit gamma-2.4 code. */
function delinearizeLut(): Uint8Array {
  if (!delinLut) {
    delinLut = new Uint8Array(DELIN_MAX + 1);
    for (let i = 0; i <= DELIN_MAX; i++) {
      const s = i / DELIN_MAX;
      delinLut[i] = Math.round(255 * Math.pow(s * s, 1 / 2.4));
    }
  }
  return delinLut;
}

// ── Colourimetry ────────────────────────────────────────────────────────────

/** Luma coefficients [Kr, Kb] per WebCodecs matrix name. */
export function lumaCoefficients(matrix: string | null): [number, number] {
  switch (matrix) {
    case "bt709":
      return [0.2126, 0.0722];
    case "bt470bg":
    case "smpte170m":
      return [0.299, 0.114];
    default: // "bt2020-ncl" and untagged HDR
      return [0.2627, 0.0593];
  }
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Linear BT.2020 → linear BT.709 (row-major). */
const BT2020_TO_BT709 = [
  1.660491, -0.587641, -0.07285,
  -0.12455, 1.1329, -0.008349,
  -0.018151, -0.100579, 1.11873,
];

/** Source primaries → BT.709 (row-major). Untagged HDR is BT.2020 in practice. */
export function gamutMatrix(primaries: string | null): number[] {
  return primaries === "bt709" ? IDENTITY : BT2020_TO_BT709;
}

// ── The conversion ──────────────────────────────────────────────────────────

/** Planar Y'CbCr picture. Plane strides are in SAMPLES, not bytes. */
export interface YuvPicture {
  width: number;
  height: number;
  /** Bits per sample (8, 10 or 12). */
  depth: number;
  /** log2 chroma subsampling: 1/1 = 4:2:0, 1/0 = 4:2:2, 0/0 = 4:4:4. */
  subX: 0 | 1;
  subY: 0 | 1;
  y: Uint16Array;
  u: Uint16Array;
  v: Uint16Array;
  yStride: number;
  uStride: number;
  vStride: number;
  transfer: HdrTransfer;
  /** WebCodecs names; null = assume BT.2020 / BT.2020-NCL. */
  primaries: string | null;
  matrix: string | null;
  fullRange: boolean;
}

/** Code-value offsets/scales that normalise a picture's Y'CbCr to [0,1] /
 *  [-0.5,0.5], from its bit depth and range. */
export function yuvScaling(pic: Pick<YuvPicture, "depth" | "fullRange">): {
  yOff: number;
  yRange: number;
  cMid: number;
  cRange: number;
} {
  const codes = 1 << pic.depth;
  const shift = pic.depth - 8;
  return {
    yOff: pic.fullRange ? 0 : 16 << shift,
    yRange: pic.fullRange ? codes - 1 : 219 << shift,
    cMid: 1 << (pic.depth - 1),
    cRange: pic.fullRange ? codes - 1 : 224 << shift,
  };
}

/**
 * Tone-map an HDR Y'CbCr picture to SDR BT.709, tightly packed RGBA
 * (`width × height × 4`, alpha 255). Pure and synchronous; `out` may be
 * supplied to reuse a buffer.
 */
export function tonemapToRgba(pic: YuvPicture, out?: Uint8Array): Uint8Array {
  const { width, height, depth, subX, subY, y: Y, u: U, v: V } = pic;
  const rgba = out ?? new Uint8Array(width * height * 4);
  const { lin, gain } = lutsFor(pic.transfer);
  const delin = delinearizeLut();

  // Y'CbCr → 15-bit R'G'B' as integer tables over the code values, so the
  // per-pixel work is adds and clamps.
  const codes = 1 << depth;
  const { yOff, yRange, cMid, cRange } = yuvScaling(pic);
  const [kr, kb] = lumaCoefficients(pic.matrix);
  const kg = 1 - kr - kb;
  const yTab = new Int32Array(codes);
  const rvTab = new Int32Array(codes);
  const guTab = new Int32Array(codes);
  const gvTab = new Int32Array(codes);
  const buTab = new Int32Array(codes);
  for (let i = 0; i < codes; i++) {
    const c = ((i - cMid) / cRange) * SIGNAL_MAX;
    yTab[i] = Math.round(((i - yOff) / yRange) * SIGNAL_MAX);
    rvTab[i] = Math.round(2 * (1 - kr) * c);
    buTab[i] = Math.round(2 * (1 - kb) * c);
    guTab[i] = Math.round(((-2 * kb * (1 - kb)) / kg) * c);
    gvTab[i] = Math.round(((-2 * kr * (1 - kr)) / kg) * c);
  }

  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = gamutMatrix(pic.primaries) as [
    number, number, number, number, number, number, number, number, number,
  ];
  const step = 1 << subX;
  const chromaW = (width + step - 1) >> subX;

  for (let py = 0; py < height; py++) {
    const yRow = py * pic.yStride;
    const uRow = (py >> subY) * pic.uStride;
    const vRow = (py >> subY) * pic.vStride;
    let o = py * width * 4;
    for (let cx = 0; cx < chromaW; cx++) {
      const u = U[uRow + cx]!;
      const v = V[vRow + cx]!;
      const rv = rvTab[v]!;
      const gc = guTab[u]! + gvTab[v]!;
      const bu = buTab[u]!;
      const x0 = cx << subX;
      const x1 = Math.min(x0 + step, width);
      for (let px = x0; px < x1; px++) {
        const yy = yTab[Y[yRow + px]!]!;
        let r = yy + rv;
        let g = yy + gc;
        let b = yy + bu;
        r = r < 0 ? 0 : r > SIGNAL_MAX ? SIGNAL_MAX : r;
        g = g < 0 ? 0 : g > SIGNAL_MAX ? SIGNAL_MAX : g;
        b = b < 0 ? 0 : b > SIGNAL_MAX ? SIGNAL_MAX : b;

        // One gain for the pixel, from its brightest channel (pre-gamut, as
        // tonemapx does), keeps the whole signal in range without hue shift.
        const k = gain[r > g ? (r > b ? r : b) : g > b ? g : b]!;
        const rl = lin[r]!;
        const gl = lin[g]!;
        const bl = lin[b]!;
        let ro = (m00 * rl + m01 * gl + m02 * bl) * k;
        let go = (m10 * rl + m11 * gl + m12 * bl) * k;
        let bo = (m20 * rl + m21 * gl + m22 * bl) * k;
        ro = ro > 0 ? (ro < 1 ? ro : 1) : 0;
        go = go > 0 ? (go < 1 ? go : 1) : 0;
        bo = bo > 0 ? (bo < 1 ? bo : 1) : 0;

        rgba[o] = delin[(Math.sqrt(ro) * DELIN_MAX + 0.5) | 0]!;
        rgba[o + 1] = delin[(Math.sqrt(go) * DELIN_MAX + 0.5) | 0]!;
        rgba[o + 2] = delin[(Math.sqrt(bo) * DELIN_MAX + 0.5) | 0]!;
        rgba[o + 3] = 255;
        o += 4;
      }
    }
  }
  return rgba;
}

// ── VideoSample adapter ─────────────────────────────────────────────────────

/** The planar Y'CbCr layouts a decoder hands us for HDR footage. */
const PLANAR_FORMATS: Record<string, { depth: number; subX: 0 | 1; subY: 0 | 1 }> = {
  I420: { depth: 8, subX: 1, subY: 1 },
  I420P10: { depth: 10, subX: 1, subY: 1 },
  I420P12: { depth: 12, subX: 1, subY: 1 },
  I422: { depth: 8, subX: 1, subY: 0 },
  I422P10: { depth: 10, subX: 1, subY: 0 },
  I422P12: { depth: 12, subX: 1, subY: 0 },
  I444: { depth: 8, subX: 0, subY: 0 },
  I444P10: { depth: 10, subX: 0, subY: 0 },
  I444P12: { depth: 12, subX: 0, subY: 0 },
};

/** True when the decoded sample is tagged with an HDR transfer function. */
export function isHdrSample(sample: VideoSample): boolean {
  // Widened: this TS lib's WebCodecs union predates the HDR transfer names,
  // but @mediabunny/server reports "hlg" / "pq" at runtime.
  const t = sample.colorSpace.transfer as string | null;
  return t === "hlg" || t === "pq";
}

let warnedFormat = false;

/**
 * Reads HDR-tagged VideoSamples and converts them to SDR RGBA on the CPU.
 * Holds one scratch buffer for the sample's native planes, reused across
 * frames. Not safe for interleaved concurrent use — give each decode cursor
 * its own instance (a cursor converts strictly sequentially).
 *
 * The render loop tone-maps on the GPU instead (`hdrToSdrGpu.ts`, fed by
 * {@link readPicture}); {@link toRgba} is the reference implementation and
 * the path for callers without a device (tests, freeze frames).
 */
export class HdrToSdrConverter {
  private scratch: ArrayBuffer | null = null;

  /**
   * Copy `sample`'s native Y'CbCr planes out and describe them. The planes
   * are views into this converter's scratch buffer — valid until the next
   * call. Null when the pixel format is not planar Y'CbCr (hardware surfaces,
   * alpha, packed RGB).
   */
  async readPicture(sample: VideoSample): Promise<YuvPicture | null> {
    const info = sample.format ? PLANAR_FORMATS[sample.format] : undefined;
    if (!info) return null;
    const width = sample.codedWidth;
    const height = sample.codedHeight;
    const size = sample.allocationSize();
    if (!this.scratch || this.scratch.byteLength < size) this.scratch = new ArrayBuffer(size);
    const planes = await sample.copyTo(new Uint8Array(this.scratch, 0, size));
    const [py, pu, pv] = planes as [PlaneLayoutLike, PlaneLayoutLike, PlaneLayoutLike];
    const { depth, subX, subY } = info;
    const bytes = depth > 8 ? 2 : 1;
    const chromaH = (height + (1 << subY) - 1) >> subY;
    const view = (p: PlaneLayoutLike, rows: number): Uint16Array => {
      // 8-bit HDR is rare; widen it so everything downstream sees one array type.
      if (bytes === 1) return Uint16Array.from(new Uint8Array(this.scratch!, p.offset, p.stride * rows));
      if (p.offset % 2 !== 0 || p.stride % 2 !== 0) {
        throw new Error("hdrToSdr: 16-bit plane is not 2-byte aligned");
      }
      // Decoded high-bit-depth planes are little-endian, as is every host we run on.
      return new Uint16Array(this.scratch!, p.offset, (p.stride * rows) / 2);
    };
    const cs = sample.colorSpace;
    return {
      width,
      height,
      depth,
      subX,
      subY,
      y: view(py, height),
      u: view(pu, chromaH),
      v: view(pv, chromaH),
      yStride: py.stride / bytes,
      uStride: pu.stride / bytes,
      vStride: pv.stride / bytes,
      transfer: cs.transfer as string as HdrTransfer,
      primaries: cs.primaries,
      matrix: cs.matrix,
      fullRange: cs.fullRange === true,
    };
  }

  /** Tone-map `sample` to SDR and return its pixels as tightly packed RGBA
   *  (coded dimensions, no rotation applied). */
  async toRgba(sample: VideoSample): Promise<Uint8Array> {
    const pic = await this.readPicture(sample);
    if (pic) return tonemapToRgba(pic);
    // Not a layout we read. Better an un-tone-mapped frame than a failed
    // render — but say so once.
    if (!warnedFormat) {
      warnedFormat = true;
      console.warn(
        `hdrToSdr: HDR sample in unsupported pixel format ${sample.format ?? "(unknown)"}; ` +
          "leaving it un-tone-mapped",
      );
    }
    const plain = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
    await sample.copyTo(plain, { format: "RGBA" });
    return plain;
  }

  dispose(): void {
    this.scratch = null;
  }
}

interface PlaneLayoutLike {
  offset: number;
  stride: number;
}
