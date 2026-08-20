/**
 * Length-preserving pitch shifter as a pure Web Audio node graph — the
 * classic dual-delay-line granular design (Chris Wilson's "Jungle"): two
 * delay lines whose delayTime is swept by looped sawtooth ramps (resampling
 * the signal by a constant rate without consuming it faster), windowed by
 * equal-power crossfade grains half a period apart so the sweep's wrap-around
 * discontinuity always lands where that grain's gain is zero.
 *
 * Runs identically on a browser AudioContext (preview) and an
 * OfflineAudioContext (headless renderer, node-web-audio-api) — parity by
 * construction, like the shared compositor. Expected artifacts: grain-rate
 * amplitude sidebands (the granular sound), and an inherent latency of
 * ~`GRAIN_PERIOD·|2^(st/12)−1|/2` (≈50 ms at ±1 octave).
 *
 * The shift is fixed at construction — `pitch` is not animatable.
 */

/** Grain cycle length (s). Each delay sweep + crossfade window loops at this
 *  period; the modulation depth scales with it (depth = period·|r−1|). */
const GRAIN_PERIOD = 0.1;

export interface PitchShifter {
  /** Connect the dry signal here. */
  input: AudioNode;
  /** Shifted signal comes out here. */
  output: AudioNode;
  /** Stop the looped modulation sources and disconnect everything. Realtime
   *  contexts must call this when the clip goes away or the loops run
   *  forever; offline contexts can skip it. */
  dispose(): void;
}

/** Equal-power crossfade window: sqrt ramp up over the first half period,
 *  sqrt ramp down over the second. The two half-period-offset copies sum to
 *  unity power. */
function createFadeBuffer(ctx: BaseAudioContext): AudioBuffer {
  const n = Math.max(2, Math.round(GRAIN_PERIOD * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const p = buffer.getChannelData(0);
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    p[i] = i < half ? Math.sqrt(i / half) : Math.sqrt(1 - (i - half) / half);
  }
  return buffer;
}

/** Normalized delay sweep: 1→0 for shifting up (delay shrinking → the read
 *  head outruns the write head → rate >1), 0→1 for shifting down. */
function createSweepBuffer(ctx: BaseAudioContext, up: boolean): AudioBuffer {
  const n = Math.max(2, Math.round(GRAIN_PERIOD * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const p = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const x = i / n;
    p[i] = up ? 1 - x : x;
  }
  return buffer;
}

/**
 * Build a pitch shifter on `ctx`. `semitones` may be fractional and
 * negative; `0` yields a passthrough. Sources start at `when` (default: the
 * context's current time — pass a scheduled time to align with other events).
 *
 * A delay swept at slope `s` (s/s) plays the signal back at rate `1 − s`;
 * a normalized ramp over GRAIN_PERIOD scaled by `depth` has slope
 * `±depth/GRAIN_PERIOD`, so `depth = GRAIN_PERIOD·|r − 1|` resamples by
 * exactly `r = 2^(semitones/12)`.
 */
export function createPitchShifter(
  ctx: BaseAudioContext,
  semitones: number,
  when: number = ctx.currentTime,
): PitchShifter {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const ratio = Math.pow(2, semitones / 12);
  if (ratio === 1) {
    input.connect(output);
    return { input, output, dispose: () => input.disconnect() };
  }

  const depth = GRAIN_PERIOD * Math.abs(ratio - 1);
  const fadeBuffer = createFadeBuffer(ctx);
  const sweepBuffer = createSweepBuffer(ctx, ratio > 1);
  const startAt = Math.max(when, ctx.currentTime);
  const sources: AudioBufferSourceNode[] = [];

  for (const side of [0, 1]) {
    // The second grain runs the same loops from half a period in.
    const offset = side === 0 ? 0 : GRAIN_PERIOD / 2;

    const delay = ctx.createDelay(Math.max(depth, 0.01) + 0.01);
    delay.delayTime.value = 0;
    const sweep = ctx.createBufferSource();
    sweep.buffer = sweepBuffer;
    sweep.loop = true;
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = depth;
    sweep.connect(sweepGain);
    sweepGain.connect(delay.delayTime);

    const window = ctx.createGain();
    window.gain.value = 0;
    const fade = ctx.createBufferSource();
    fade.buffer = fadeBuffer;
    fade.loop = true;
    fade.connect(window.gain);

    input.connect(delay);
    delay.connect(window);
    window.connect(output);

    sweep.start(startAt, offset);
    fade.start(startAt, offset);
    sources.push(sweep, fade);
  }

  return {
    input,
    output,
    dispose: () => {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          // already stopped
        }
        s.disconnect();
      }
      input.disconnect();
      output.disconnect();
    },
  };
}
