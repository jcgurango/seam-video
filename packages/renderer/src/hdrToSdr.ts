/**
 * HDR → SDR input conversion for the headless renderer.
 *
 * The preview gets this for free: Chromium's WebCodecs → WebGPU upload honours
 * a frame's colour tags and tone-maps HLG/PQ to sRGB. The renderer's decode
 * goes through mediabunny's swscale RGBA conversion, which ignores transfer,
 * primaries and tone mapping entirely, so HDR clips came out flat and
 * desaturated. This module is seam's opinionated default for that gap: any
 * sample tagged HLG or PQ is run through the jellyfin-ffmpeg `tonemapx`
 * filter (node-av bundles the Jellyfin build) with the same chain we validated
 * visually against Apple's avconvert, then converted to RGBA with the BT.709
 * matrix. SDR samples are untouched.
 *
 * What the chain does (tonemapx source + measurement, see the test): BT.2020
 * YUV → linear RGB in 203-nit reference-white units (PQ via the ST.2084 EOTF;
 * HLG via the standard OOTF, system gamma 1.2, normalised so 75 % signal is
 * scene white — NOT the BT.2446-B variant found in jellyfin-ffmpeg master,
 * i.e. this depends on the jellyfin revision node-av bundles), BT.2020 →
 * BT.709 primaries matrix, hable curve scaled by the max channel against a
 * fixed 1000-nit peak (`peak=100`), clip, 2.4 gamma (inverse BT.1886), BT.709
 * full-range 8-bit YUV. Chroma is nearest-upsampled on the way in and
 * box-averaged on the way out. Net: HLG 75 % → 0.62 SDR, HLG 100 % → 0.95.
 */
import * as NodeAv from "node-av";
import { toAvFrame } from "@mediabunny/server";
import type { VideoSample } from "mediabunny";

/** The validated tonemapx chain. `peak=100` is tonemapx's unit for 1000 nits
 *  (`peak / 10 × 100 / 203` in its 203-nit reference-white domain); with an
 *  HLG source it is a no-op versus the Dolby Vision L0 peak iPhones write,
 *  but pinning it keeps every HDR source on one predictable curve. */
export const HDR_TO_SDR_CHAIN =
  "tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p";

/** YUV (tonemapx output: BT.709, full range) → tightly packed RGBA. The
 *  matrix/range are forced rather than read from tags so this stays correct
 *  even if a future node-av build's swscale ignores frame colour props. */
const TO_RGBA_CHAIN = "scale=in_color_matrix=bt709:in_range=pc:flags=bilinear,format=rgba";

/** True when the decoded sample is tagged with an HDR transfer function. */
export function isHdrSample(sample: VideoSample): boolean {
  // Widened: this TS lib's WebCodecs union predates the HDR transfer names,
  // but @mediabunny/server reports "hlg" / "pq" at runtime.
  const t = sample.colorSpace.transfer as string | null;
  return t === "hlg" || t === "pq";
}

/**
 * Converts HDR-tagged VideoSamples to SDR RGBA. Holds one libavfilter graph,
 * rebuilt only when the input geometry/format/tags change, plus two reusable
 * AVFrames. Not safe for interleaved concurrent use — give each decode cursor
 * its own instance (a cursor converts strictly sequentially).
 */
export class HdrToSdrConverter {
  private graph: NodeAv.FilterGraph | null = null;
  private src: NodeAv.FilterContext | null = null;
  private sink: NodeAv.FilterContext | null = null;
  private graphKey = "";
  private readonly inFrame = new NodeAv.Frame();
  private readonly outFrame = new NodeAv.Frame();

  /** `chain` overrides the tonemap stage (tests / experiments); the output
   *  must still be BT.709 full-range YUV for the RGBA stage to read it right. */
  constructor(private readonly chain: string = HDR_TO_SDR_CHAIN) {
    this.inFrame.alloc();
    this.outFrame.alloc();
  }

  /** Tone-map `sample` to SDR and return its pixels as tightly packed RGBA
   *  (coded dimensions, no rotation applied). */
  async toRgba(sample: VideoSample): Promise<Uint8Array> {
    // Refs the decoded AVFrame (no pixel copy) — the sample keeps its own ref.
    await toAvFrame(sample, this.inFrame);
    const f = this.inFrame;
    const width = f.width;
    const height = f.height;
    const key = [
      width,
      height,
      f.format,
      f.colorTrc,
      f.colorSpace,
      f.colorPrimaries,
      f.colorRange,
      f.sampleAspectRatio.num,
      f.sampleAspectRatio.den,
    ].join(":");
    if (key !== this.graphKey) {
      this.freeGraph();
      this.buildGraph(f);
      this.graphKey = key;
    }

    // buffersrc takes over the frame's data refs and resets our wrapper.
    NodeAv.FFmpegError.throwIfError(
      await this.src!.buffersrcAddFrame(f),
      "hdrToSdr: buffersrcAddFrame",
    );
    NodeAv.FFmpegError.throwIfError(
      await this.sink!.buffersinkGetFrame(this.outFrame),
      "hdrToSdr: buffersinkGetFrame",
    );

    try {
      const out = this.outFrame;
      const plane = out.data?.[0];
      if (!plane) throw new Error("hdrToSdr: filter output has no data plane");
      const stride = out.linesize[0]!;
      const rowBytes = width * 4;
      const rgba = new Uint8Array(rowBytes * height);
      if (stride === rowBytes) {
        rgba.set(plane.subarray(0, rowBytes * height));
      } else {
        for (let y = 0; y < height; y++) {
          rgba.set(plane.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
        }
      }
      return rgba;
    } finally {
      this.outFrame.unref();
    }
  }

  private buildGraph(f: NodeAv.Frame): void {
    const graph = new NodeAv.FilterGraph();
    graph.alloc();
    const sar = f.sampleAspectRatio;
    const srcArgs =
      `video_size=${f.width}x${f.height}` +
      `:pix_fmt=${f.format}` +
      `:time_base=1/1000000` +
      `:pixel_aspect=${sar.num || 1}/${sar.den || 1}`;
    const src = graph.createFilter(NodeAv.Filter.getByName("buffer")!, "src", srcArgs);
    const sink = graph.createFilter(NodeAv.Filter.getByName("buffersink")!, "sink");
    if (!src || !sink) {
      graph.free();
      throw new Error("hdrToSdr: failed to create buffer source/sink");
    }
    // Naming follows FFmpeg's parse semantics: the parsed chain's inputs are
    // fed by the graph's existing outputs (buffer src) and vice versa.
    const outputs = NodeAv.FilterInOut.createList([{ name: "in", filterCtx: src, padIdx: 0 }]);
    const inputs = NodeAv.FilterInOut.createList([{ name: "out", filterCtx: sink, padIdx: 0 }]);
    const chain = `[in]${this.chain},${TO_RGBA_CHAIN}[out]`;
    const parseRet = graph.parsePtr(chain, inputs, outputs);
    if (parseRet < 0) {
      graph.free();
      NodeAv.FFmpegError.throwIfError(parseRet, "hdrToSdr: FilterGraph.parsePtr");
    }
    const configRet = graph.configSync();
    if (configRet < 0) {
      graph.free();
      NodeAv.FFmpegError.throwIfError(configRet, "hdrToSdr: FilterGraph.config");
    }
    this.graph = graph;
    this.src = src;
    this.sink = sink;
  }

  private freeGraph(): void {
    this.graph?.free();
    this.graph = null;
    this.src = null;
    this.sink = null;
    this.graphKey = "";
  }

  dispose(): void {
    this.freeGraph();
    this.inFrame.free();
    this.outFrame.free();
  }
}
