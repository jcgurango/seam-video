import { describe, expect, it } from "vitest";
import {
  applyAgc,
  kWeightingFilters,
  limitTruePeak,
  LoudnessAnalyzer,
  measureIntegratedLoudness,
  measureTruePeak,
} from "../loudness.js";

const SR = 48000;

/** Sine of `seconds` at `freq` Hz, amplitude `amp`, optional phase. */
function sine(seconds: number, amp: number, freq = 1000, phase = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const dbToAmp = (db: number) => Math.pow(10, db / 20);
const stereo = (ch: Float32Array) => [ch, new Float32Array(ch)];

describe("K-weighting", () => {
  it("reproduces the BS.1770-4 coefficient table at 48 kHz", () => {
    const [shelf, hp] = kWeightingFilters(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 4);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 4);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 4);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 4);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 4);
    expect(hp.b0).toBeCloseTo(1.0, 4);
    expect(hp.b1).toBeCloseTo(-2.0, 4);
    expect(hp.b2).toBeCloseTo(1.0, 4);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 4);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 4);
  });
});

describe("integrated loudness", () => {
  it("reads a full-scale 1 kHz mono sine at −3.01 LUFS", () => {
    expect(measureIntegratedLoudness([sine(2, 1)], SR)).toBeCloseTo(-3.01, 1);
  });

  it("reads a −20 dBFS stereo 1 kHz sine at −20 LUFS", () => {
    expect(measureIntegratedLoudness(stereo(sine(2, dbToAmp(-20))), SR)).toBeCloseTo(-20, 1);
  });

  it("gates out silence and quiet passages (R128 absolute + relative gates)", () => {
    // (Long enough that the handful of 400 ms blocks straddling the seam —
    // which the spec does count — don't move the mean.)
    const tone = sine(20, dbToAmp(-23));
    const silence = new Float32Array(10 * SR);
    expect(measureIntegratedLoudness(stereo(concat(tone, silence)), SR)).toBeCloseTo(-23, 1);
    // A passage 20 LU under the body sits below the relative gate too.
    const whisper = sine(10, dbToAmp(-43));
    expect(measureIntegratedLoudness(stereo(concat(tone, whisper)), SR)).toBeCloseTo(-23, 1);
    expect(measureIntegratedLoudness(stereo(silence), SR)).toBe(-Infinity);
  });

  it("works at other sample rates", () => {
    const n = 44100 * 2;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
    expect(measureIntegratedLoudness([ch], 44100)).toBeCloseTo(-3.01, 1);
  });

  it("answers short-term loudness over a trailing window", () => {
    const an = new LoudnessAnalyzer(stereo(concat(sine(3, dbToAmp(-30)), sine(3, dbToAmp(-10)))), SR);
    expect(an.shortTerm(3 * SR)).toBeCloseTo(-30, 1);
    expect(an.shortTerm(6 * SR)).toBeCloseTo(-10, 1);
  });
});

describe("true peak", () => {
  it("matches the sample peak for a well-sampled sine", () => {
    expect(measureTruePeak([sine(1, 0.5)])).toBeCloseTo(-6.02, 1);
  });

  it("finds the inter-sample peak a sample-peak meter misses", () => {
    // 12 kHz at 48 kHz sampled at phase π/4: every sample is ±0.707 but the
    // waveform peaks at 1.0 between them.
    const ch = sine(1, 1, 12000, Math.PI / 4);
    let samplePeak = 0;
    for (const v of ch) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-3.01, 1);
    expect(measureTruePeak([ch])).toBeGreaterThan(-0.2);
    expect(measureTruePeak([ch])).toBeLessThan(0.2);
  });
});

describe("true-peak limiter", () => {
  it("leaves audio under the ceiling untouched", () => {
    const ch = sine(1, dbToAmp(-3));
    const before = new Float32Array(ch);
    expect(limitTruePeak([ch], SR, { ceilingDbtp: -1 })).toBe(0);
    expect(ch).toEqual(before);
  });

  it("holds a hot programme at the ceiling, stereo-linked", () => {
    const l = sine(2, 1.0);
    const r = sine(2, 0.5);
    const reduction = limitTruePeak([l, r], SR, { ceilingDbtp: -1 });
    expect(reduction).toBeLessThan(-0.9);
    expect(measureTruePeak([l, r])).toBeLessThanOrEqual(-1 + 0.05);
    // Linked: the quiet channel was reduced by the same gain.
    let rPeak = 0;
    for (const v of r) rPeak = Math.max(rPeak, Math.abs(v));
    expect(20 * Math.log10(rPeak)).toBeCloseTo(-6.02 + reduction, 0);
  });

  it("catches isolated transients on a quiet bed", () => {
    const ch = sine(2, dbToAmp(-20));
    for (const at of [0.3, 0.9, 1.5]) {
      const i = Math.round(at * SR);
      ch[i] = 1.0;
      ch[i + 1] = -0.95;
    }
    limitTruePeak([ch], SR, { ceilingDbtp: -1 });
    expect(measureTruePeak([ch])).toBeLessThanOrEqual(-1 + 0.05);
    // The bed between transients is untouched once the limiter has released.
    expect(Math.abs(ch[Math.round(0.6 * SR)])).toBeGreaterThan(0);
    const an = new LoudnessAnalyzer([ch], SR);
    expect(an.loudness(Math.round(0.5 * SR), Math.round(0.85 * SR))).toBeCloseTo(-20 - 3.01, 0);
  });
});

describe("applyAgc", () => {
  it("normalises a quiet, steady programme onto −14 LUFS under −1 dBTP", () => {
    const { channels, report } = applyAgc(stereo(sine(6, dbToAmp(-32))), SR);
    expect(report.inputLufs).toBeCloseTo(-32, 0);
    expect(report.outputLufs).toBeCloseTo(-14, 0);
    expect(measureIntegratedLoudness(channels, SR)).toBeCloseTo(-14, 0);
    expect(report.outputTruePeakDbtp).toBeLessThanOrEqual(-1 + 0.05);
  });

  it("evens out a quiet half and a loud half (the rider), then lands on target", () => {
    const quiet = sine(8, dbToAmp(-24));
    const loud = sine(8, dbToAmp(-14));
    const { channels, report } = applyAgc(stereo(concat(quiet, loud)), SR);
    const an = new LoudnessAnalyzer(channels, SR);
    // Steady-state short-term loudness of each half, well after the seam.
    const quietOut = an.shortTerm(7 * SR);
    const loudOut = an.shortTerm(16 * SR);
    expect(Math.abs(quietOut - loudOut)).toBeLessThan(1.5);
    expect(report.riderMaxDb - report.riderMinDb).toBeGreaterThan(8);
    expect(report.outputLufs).toBeCloseTo(-14, 0);
    expect(report.outputTruePeakDbtp).toBeLessThanOrEqual(-1 + 0.05);
  });

  it("never lifts near-silence: the rider holds its gain through a pause", () => {
    const speech = sine(5, dbToAmp(-24));
    const pause = sine(4, dbToAmp(-75)); // room tone far under the gate
    const { channels, report } = applyAgc(stereo(concat(speech, pause, speech)), SR);
    const an = new LoudnessAnalyzer(channels, SR);
    // The pause stays a pause: nowhere near the target.
    expect(an.loudness(Math.round(6 * SR), Math.round(8.5 * SR))).toBeLessThan(-50);
    expect(report.riderMaxDb).toBeLessThanOrEqual(12);
  });

  it("can only close a gap up to maxBoostDb; the trim still hits the target", () => {
    // 20 dB apart with a 12 dB boost cap: the quiet half ends up ~8 dB under.
    const { channels } = applyAgc(stereo(concat(sine(8, dbToAmp(-34)), sine(8, dbToAmp(-14)))), SR);
    const an = new LoudnessAnalyzer(channels, SR);
    expect(an.shortTerm(16 * SR) - an.shortTerm(7 * SR)).toBeCloseTo(8, 0);
  });

  it("caps the boost at maxBoostDb", () => {
    const { report } = applyAgc(stereo(sine(6, dbToAmp(-40))), SR, { maxBoostDb: 6 });
    expect(report.riderMaxDb).toBeLessThanOrEqual(6 + 1e-6);
    // The static trim still lands the integrated loudness on target.
    expect(report.outputLufs).toBeCloseTo(-14, 0);
  });

  it("honours a custom target", () => {
    const { report } = applyAgc(stereo(sine(6, dbToAmp(-20))), SR, { targetLufs: -23 });
    expect(report.outputLufs).toBeCloseTo(-23, 0);
  });

  it("passes silence through untouched", () => {
    const { channels, report } = applyAgc(stereo(new Float32Array(SR)), SR);
    expect(report.inputLufs).toBe(-Infinity);
    expect(report.outputLufs).toBe(-Infinity);
    expect(channels[0].every((v) => v === 0)).toBe(true);
  });

  it("does not modify its input", () => {
    const src = stereo(sine(2, dbToAmp(-30)));
    const copy = src.map((c) => new Float32Array(c));
    applyAgc(src, SR);
    expect(src[0]).toEqual(copy[0]);
    expect(src[1]).toEqual(copy[1]);
  });
});
