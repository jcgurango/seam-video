/**
 * Offline loudness tools for the renderer's mixed audio, after ITU-R BS.1770-4
 * / EBU R128: K-weighted integrated + short-term loudness (gated), 4×
 * oversampled true peak, a brickwall true-peak limiter, and `applyAgc` — the
 * CLI's `--agc` mastering pass that lands a render on a platform loudness
 * target (Instagram Reels / YouTube Shorts / TikTok all normalise to about
 * −14 LUFS integrated with peaks under −1 dBTP; deliver there and the
 * platform neither turns you down nor leaves you quieter than the next clip).
 *
 * `applyAgc` is three stages, all pure functions over Float32 channel data:
 *   1. gain rider  — a slow automatic gain control: the short-term loudness
 *      (3 s window) is steered toward the target with asymmetric smoothing
 *      (fast when the programme gets louder, slow when it gets quieter),
 *      bounded by `maxBoostDb`/`maxCutDb` and frozen on near-silence so a
 *      noise floor is never pumped up. This evens out a vlog's quiet and loud
 *      passages the way a broadcast AGC would.
 *   2. trim        — one static gain so the *integrated* loudness lands on the
 *      target exactly (the rider gets close; this makes it precise).
 *   3. limiter     — lookahead true-peak limiter at `truePeakDbtp` so the
 *      inter-sample peaks the platform's AAC transcode would clip stay under
 *      the ceiling (stereo-linked, 5 ms lookahead, ~80 ms release).
 * Nothing here touches the preview: this is an export-time mastering step.
 */

// ── biquads + K-weighting ──────────────────────────────────────────

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for `sampleRate`, derived from the analogue
 *  prototypes (RBJ cookbook) so any rate works; at 48 kHz they reproduce the
 *  BS.1770 table (pinned in the tests). Stage 1 is the +4 dB high shelf
 *  ("head" model), stage 2 the RLB high-pass. */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Bilinear-transform forms as in libebur128 (`ebur128_init_filter`): the
  // RBJ cookbook shelf lands ~0.25 dB off the table, these hit it.
  // Stage 1: high shelf, f0 ≈ 1681.97 Hz, Q ≈ 0.7072, +3.9998 dB.
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const gainDb = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const vh = Math.pow(10, gainDb / 20);
    const vb = Math.pow(vh, 0.4996667741545416);
    const a0 = 1 + k / q + k * k;
    return {
      b0: (vh + (vb * k) / q + k * k) / a0,
      b1: (2 * (k * k - vh)) / a0,
      b2: (vh - (vb * k) / q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  })();
  // Stage 2: RLB high-pass, f0 ≈ 38.135 Hz, Q ≈ 0.5003 (numerator left
  // un-normalised, as the BS.1770 table has it).
  const hp = (() => {
    const f0 = 38.13547087602444;
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + k / q + k * k;
    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  })();
  return [shelf, hp];
}

function biquad(x: ArrayLike<number>, c: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return y;
}

// ── loudness analysis ──────────────────────────────────────────────

const LOUDNESS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SEC = 0.4;
const HOP_SEC = 0.1;

/** BS.1770 channel weights: L/R/C = 1, LFE = 0, Ls/Rs = 1.41 (5.1 order). */
function channelWeight(index: number, count: number): number {
  if (count <= 3) return 1;
  return [1, 1, 1, 0, 1.41, 1.41][index] ?? 1;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const powerToLufs = (p: number) => (p > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(p) : -Infinity);

/** K-weights the programme once and answers loudness questions about any
 *  sample range in O(1) via a prefix sum of the channel-weighted power. */
export class LoudnessAnalyzer {
  readonly length: number;
  private readonly prefix: Float64Array;

  constructor(channels: Float32Array[], readonly sampleRate: number) {
    this.length = channels[0]?.length ?? 0;
    const prefix = new Float64Array(this.length + 1);
    const [shelf, hp] = kWeightingFilters(sampleRate);
    channels.forEach((ch, c) => {
      const w = channelWeight(c, channels.length);
      if (w === 0) return;
      const y = biquad(biquad(ch, shelf), hp);
      for (let i = 0; i < y.length; i++) prefix[i + 1] += w * y[i] * y[i];
    });
    // Per-sample weighted power summed over channels → prefix sum.
    for (let i = 1; i <= this.length; i++) prefix[i] += prefix[i - 1];
    this.prefix = prefix;
  }

  /** Mean channel-weighted K-power over samples [a, b). */
  power(a: number, b: number): number {
    a = Math.max(0, Math.min(this.length, Math.floor(a)));
    b = Math.max(0, Math.min(this.length, Math.floor(b)));
    if (b <= a) return 0;
    return (this.prefix[b] - this.prefix[a]) / (b - a);
  }

  /** Loudness (LUFS) of samples [a, b); −Infinity for digital silence. */
  loudness(a: number, b: number): number {
    return powerToLufs(this.power(a, b));
  }

  /** Short-term loudness (LUFS) of the `windowSec` ending at `endSample`. */
  shortTerm(endSample: number, windowSec = 3): number {
    const w = Math.round(windowSec * this.sampleRate);
    return this.loudness(endSample - w, endSample);
  }

  /** Gated integrated loudness (LUFS) of the whole programme: 400 ms blocks at
   *  100 ms hops, absolute gate at −70 LUFS, relative gate 10 LU under the
   *  mean of what survives. −Infinity when nothing does. */
  integrated(): number {
    const block = Math.round(BLOCK_SEC * this.sampleRate);
    const hop = Math.round(HOP_SEC * this.sampleRate);
    const powers: number[] = [];
    if (this.length <= block) {
      powers.push(this.power(0, this.length));
    } else {
      for (let start = 0; start + block <= this.length; start += hop) {
        powers.push(this.power(start, start + block));
      }
    }
    const absGated = powers.filter((p) => powerToLufs(p) > ABSOLUTE_GATE_LUFS);
    if (absGated.length === 0) return -Infinity;
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const relThreshold = powerToLufs(mean(absGated)) + RELATIVE_GATE_LU;
    const relGated = absGated.filter((p) => powerToLufs(p) > relThreshold);
    if (relGated.length === 0) return -Infinity;
    return powerToLufs(mean(relGated));
  }
}

export function measureIntegratedLoudness(channels: Float32Array[], sampleRate: number): number {
  return new LoudnessAnalyzer(channels, sampleRate).integrated();
}

// ── true peak ──────────────────────────────────────────────────────

const OVERSAMPLE = 4;
const INTERP_HALF_TAPS = 8;

/** Windowed-sinc interpolation taps for the 4 sub-sample phases (phase 0 is
 *  the identity). Each phase is normalised to unity DC gain. */
const interpPhases: Float64Array[] = (() => {
  const phases: Float64Array[] = [];
  for (let p = 0; p < OVERSAMPLE; p++) {
    const f = p / OVERSAMPLE;
    const taps = new Float64Array(2 * INTERP_HALF_TAPS + 1);
    let sum = 0;
    for (let k = -INTERP_HALF_TAPS; k <= INTERP_HALF_TAPS; k++) {
      const t = f - k;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const u = t / (INTERP_HALF_TAPS + 1); // Blackman window over the span
      const win =
        Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const h = sinc * win;
      taps[k + INTERP_HALF_TAPS] = h;
      sum += h;
    }
    for (let i = 0; i < taps.length; i++) taps[i] /= sum;
    phases.push(taps);
  }
  return phases;
})();

/** Per-sample true peak (linear, max over channels): for each sample n the
 *  largest |value| among n and the three 4×-oversampled points before n+1. */
export function truePeakPerSample(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      let peak = Math.abs(ch[i]);
      for (let p = 1; p < OVERSAMPLE; p++) {
        const taps = interpPhases[p];
        let acc = 0;
        for (let k = -INTERP_HALF_TAPS; k <= INTERP_HALF_TAPS; k++) {
          const j = i + k;
          if (j >= 0 && j < n) acc += ch[j] * taps[k + INTERP_HALF_TAPS];
        }
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
      if (peak > out[i]) out[i] = peak;
    }
  }
  return out;
}

/** Programme true peak in dBTP (−Infinity for silence). */
export function measureTruePeak(channels: Float32Array[]): number {
  const tp = truePeakPerSample(channels);
  let max = 0;
  for (let i = 0; i < tp.length; i++) if (tp[i] > max) max = tp[i];
  return linToDb(max);
}

// ── true-peak limiter ──────────────────────────────────────────────

export interface LimiterOptions {
  /** Ceiling in dBTP (default −1). */
  ceilingDbtp?: number;
  /** Lookahead = attack time (default 5 ms). */
  lookaheadSec?: number;
  /** Release time constant (default 80 ms). */
  releaseSec?: number;
}

/**
 * Stereo-linked lookahead brickwall limiter, in place. The gain curve is
 * (required gain) → sliding minimum over the lookahead → one-pole release →
 * box-smoothed over the lookahead; every stage keeps the gain at sample n
 * at or below what n itself requires, so the ceiling is a hard guarantee (to
 * the accuracy of the 4× true-peak estimate). Offline, so no output delay.
 * Returns the deepest gain reduction applied, in dB (≤ 0).
 */
export function limitTruePeak(
  channels: Float32Array[],
  sampleRate: number,
  opts: LimiterOptions = {},
): number {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return 0;
  const ceiling = dbToLin(opts.ceilingDbtp ?? -1);
  const look = Math.max(1, Math.round((opts.lookaheadSec ?? 0.005) * sampleRate));
  const releaseK = Math.exp(-1 / ((opts.releaseSec ?? 0.08) * sampleRate));

  const tp = truePeakPerSample(channels);
  let needed = false;
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (tp[i] > ceiling) {
      req[i] = ceiling / tp[i];
      needed = true;
    } else req[i] = 1;
  }
  if (!needed) return 0;

  // Sliding minimum over [i, i + look] (monotonic deque).
  const minAhead = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    // Window for i is [i, i+look]; we sweep backwards so the deque holds
    // candidates from i upward; drop those beyond i+look.
    while (tail > head && req[dq[tail - 1]] >= req[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + look) head++;
    minAhead[i] = req[dq[head]];
  }

  // Release: the gain may only recover toward 1 at the release rate.
  const rel = new Float32Array(n);
  let prev = 1;
  for (let i = 0; i < n; i++) {
    const recovered = 1 - (1 - prev) * releaseK;
    prev = Math.min(minAhead[i], recovered);
    rel[i] = prev;
  }

  // Attack: box-average over [i − look, i] (a ramp no steeper than the
  // lookahead), via a prefix sum.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + rel[i];
  let minGain = 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - look);
    const g = (prefix[i + 1] - prefix[a]) / (i + 1 - a);
    if (g < minGain) minGain = g;
    for (const ch of channels) ch[i] *= g;
  }
  return linToDb(minGain);
}

// ── automatic gain control ─────────────────────────────────────────

export interface AgcOptions {
  /** Integrated loudness target in LUFS (default −14: Reels / Shorts / TikTok). */
  targetLufs?: number;
  /** True-peak ceiling in dBTP (default −1). */
  truePeakDbtp?: number;
  /** Most the rider may lift a quiet passage (default 12 dB) — the cap that
   *  keeps room tone from being dragged up to speech level. */
  maxBoostDb?: number;
  /** Most the rider may pull a loud passage down (default 12 dB). */
  maxCutDb?: number;
  /** Short-term loudness window the rider steers (default 3 s). */
  windowSec?: number;
  /** Rider time constant when the programme gets louder (default 0.5 s). */
  attackSec?: number;
  /** Rider time constant when the programme gets quieter (default 2 s). */
  releaseSec?: number;
  /** Short-term loudness under which the rider holds its gain instead of
   *  chasing silence (default −50 LUFS). */
  gateLufs?: number;
}

export interface AgcReport {
  inputLufs: number;
  outputLufs: number;
  inputTruePeakDbtp: number;
  outputTruePeakDbtp: number;
  /** Rider gain range actually applied (dB). */
  riderMinDb: number;
  riderMaxDb: number;
  /** Static trim after the rider (dB). */
  trimDb: number;
  /** Deepest limiter gain reduction (dB, ≤ 0). */
  limiterReductionDb: number;
}

const RIDER_HOP_SEC = 0.1;

/** Gain-rider curve on a 100 ms grid (linear gains, one per hop boundary). */
function riderGains(
  analyzer: LoudnessAnalyzer,
  opts: Required<Pick<AgcOptions, "targetLufs" | "maxBoostDb" | "maxCutDb" | "windowSec" | "attackSec" | "releaseSec" | "gateLufs">>,
): { gains: Float64Array; hop: number; minDb: number; maxDb: number } {
  const fs = analyzer.sampleRate;
  const hop = Math.max(1, Math.round(RIDER_HOP_SEC * fs));
  const hops = Math.ceil(analyzer.length / hop) + 1;
  const desired = new Float64Array(hops);
  // Desired gain per hop: steer the trailing short-term loudness to target;
  // hold on (near-)silence; clamp to the boost/cut range.
  let lastDesired: number | null = null;
  const pending: number[] = [];
  for (let i = 0; i < hops; i++) {
    const end = Math.min(analyzer.length, i * hop);
    const s = end > 0 ? analyzer.shortTerm(end, opts.windowSec) : -Infinity;
    if (s === -Infinity || s < opts.gateLufs) {
      if (lastDesired == null) pending.push(i);
      else desired[i] = lastDesired;
      continue;
    }
    const g = Math.max(-opts.maxCutDb, Math.min(opts.maxBoostDb, opts.targetLufs - s));
    if (lastDesired == null) for (const j of pending) desired[j] = g;
    lastDesired = g;
    desired[i] = g;
  }
  if (lastDesired == null) {
    return { gains: new Float64Array(hops).fill(1), hop, minDb: 0, maxDb: 0 };
  }
  // Asymmetric one-pole smoothing: fast down (attack), slow up (release).
  const kAtt = 1 - Math.exp(-RIDER_HOP_SEC / opts.attackSec);
  const kRel = 1 - Math.exp(-RIDER_HOP_SEC / opts.releaseSec);
  const smooth = new Float64Array(hops);
  smooth[0] = desired[0];
  let minDb = smooth[0], maxDb = smooth[0];
  for (let i = 1; i < hops; i++) {
    const prev = smooth[i - 1];
    const k = desired[i] < prev ? kAtt : kRel;
    smooth[i] = prev + (desired[i] - prev) * k;
    if (smooth[i] < minDb) minDb = smooth[i];
    if (smooth[i] > maxDb) maxDb = smooth[i];
  }
  const gains = new Float64Array(hops);
  for (let i = 0; i < hops; i++) gains[i] = dbToLin(smooth[i]);
  return { gains, hop, minDb, maxDb };
}

/**
 * Automatic gain control + loudness normalisation + true-peak limiting of a
 * multichannel Float32 programme. Returns new channel arrays (inputs are not
 * modified) and a report of what was done.
 */
export function applyAgc(
  channels: Float32Array[],
  sampleRate: number,
  options: AgcOptions = {},
): { channels: Float32Array<ArrayBuffer>[]; report: AgcReport } {
  const opts = {
    targetLufs: options.targetLufs ?? -14,
    truePeakDbtp: options.truePeakDbtp ?? -1,
    maxBoostDb: options.maxBoostDb ?? 12,
    maxCutDb: options.maxCutDb ?? 12,
    windowSec: options.windowSec ?? 3,
    attackSec: options.attackSec ?? 0.5,
    releaseSec: options.releaseSec ?? 2,
    gateLufs: options.gateLufs ?? -50,
  };
  const out: Float32Array<ArrayBuffer>[] = channels.map((ch) => new Float32Array(ch));
  const n = out[0]?.length ?? 0;
  const input = new LoudnessAnalyzer(channels, sampleRate);
  const inputLufs = input.integrated();
  const inputTruePeakDbtp = measureTruePeak(channels);
  const report: AgcReport = {
    inputLufs,
    outputLufs: inputLufs,
    inputTruePeakDbtp,
    outputTruePeakDbtp: inputTruePeakDbtp,
    riderMinDb: 0,
    riderMaxDb: 0,
    trimDb: 0,
    limiterReductionDb: 0,
  };
  if (n === 0 || inputLufs === -Infinity) return { channels: out, report };

  // 1. Gain rider (linear interpolation between hop gains).
  const rider = riderGains(input, opts);
  for (let i = 0; i < n; i++) {
    const pos = i / rider.hop;
    const k = Math.floor(pos);
    const frac = pos - k;
    const g0 = rider.gains[k];
    const g1 = rider.gains[Math.min(rider.gains.length - 1, k + 1)];
    const g = g0 + (g1 - g0) * frac;
    for (const ch of out) ch[i] *= g;
  }
  report.riderMinDb = rider.minDb;
  report.riderMaxDb = rider.maxDb;

  // 2. Static trim onto the integrated target.
  const afterRider = new LoudnessAnalyzer(out, sampleRate).integrated();
  if (afterRider !== -Infinity) {
    const trimDb = opts.targetLufs - afterRider;
    const trim = dbToLin(trimDb);
    for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= trim;
    report.trimDb = trimDb;
  }

  // 3. True-peak limiter.
  report.limiterReductionDb = limitTruePeak(out, sampleRate, { ceilingDbtp: opts.truePeakDbtp });

  report.outputLufs = new LoudnessAnalyzer(out, sampleRate).integrated();
  report.outputTruePeakDbtp = measureTruePeak(out);
  return { channels: out, report };
}
