import type { AudioBufferSink } from "mediabunny";
import { createPitchShifter, type PitchShifter } from "@seam/core";

/** One decode→schedule pass over a clip's sink. Every buffer the pump pulls
 *  plays at `at + (buffer.timestamp − sourceTime) / speed` (context seconds),
 *  so `at` may sit in the future (pre-roll: buffers queue up ahead of the
 *  clip's start) or in the past (late start: the elapsed portion is skipped
 *  so audio stays in sync with the clock). */
interface Run {
  /** Context time at which `sourceTime` should be heard. */
  at: number;
  sourceTime: number;
  /** Context time to stop at — nodes get `stop(until)` and the pump stops
   *  pulling once a buffer would start past it. `null` = until stopped. */
  until: number | null;
  /** Scrub burst: `at`/`until` are unknown until the first buffer lands —
   *  the burst is re-anchored to that arrival and the gain envelope applied
   *  then, so decode latency never eats the audible window. */
  scrub: { durationSec: number; finalizeTimer: ReturnType<typeof setTimeout> | null } | null;
  /** Context time the first buffer was scheduled at (null until then). */
  firstBufferAt: number | null;
  /** `performance.now()` when the run started — for the latency stat. */
  startedWall: number;
}

interface ClipState {
  id: string;
  sink: AudioBufferSink;
  speed: number;
  /** Length-preserving semitone shifter between the buffer sources and the
   *  gain node, present when the clip's net `pitch` ≠ 0. Its looped
   *  modulation sources run until dispose. */
  pitchShifter: PitchShifter | null;
  /** Where pump() connects buffer sources: the shifter's input when pitched,
   *  else the gain node directly. */
  sourceTarget: AudioNode;
  /** Steady-state volume (1 = unity): animated keyframe × composition volume,
   *  WITHOUT any transient crossfade. Tracks animated keyframes when
   *  `setClipVolume` is called per frame; otherwise holds the static value.
   *  Used as the target by scrub/restore automation AND by `startClip` to reset
   *  the gain — so it must never be polluted by a crossfade ramp, else a clip
   *  that faded out (transitionOut) would restart muted. */
  volume: number;
  /** Last value actually written to `gainNode.gain` (= volume × crossfade), so
   *  per-frame updates can skip redundant param writes. */
  appliedGain: number;
  gainNode: GainNode;
  // Playback state (null when not playing)
  iterator: AsyncIterator<{ buffer: AudioBuffer; timestamp: number; duration: number }> | null;
  run: Run | null;
  queuedNodes: Set<AudioBufferSourceNode>;
  asyncId: number;
}

export interface StartClipOptions {
  /** Context time at which `sourceTime` plays. Default: now. A future value
   *  pre-rolls: the decoder spins up and buffers queue at their scheduled
   *  times, so the clip is audible from its very first sample. */
  at?: number;
  /** Context time to stop at (the clip's end). Default: until `stopClip`. */
  until?: number;
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const readDebugFlag = (): boolean => {
  try {
    return globalThis.localStorage?.getItem("seam:audio-debug") === "1";
  } catch {
    return false;
  }
};

export class AudioScheduler {
  /** `localStorage["seam:audio-debug"] = "1"` logs every run's decode→first
   *  buffer latency (the number that decides whether short clips / scrub
   *  bursts are audible at all). */
  static debug = readDebugFlag();
  /** Wall ms from the last start/scrub to its first scheduled buffer. */
  lastStartLatencyMs: number | null = null;

  audioContext!: AudioContext;
  private masterGain!: GainNode;
  private clips = new Map<string, ClipState>();
  private initialized = false;
  private readonly createContext: (sampleRate?: number) => AudioContext;

  /** AudioContext.currentTime when play/seek last happened */
  private audioStartTime = 0;
  /** Timeline position when play/seek last happened */
  private timelineStartTime = 0;
  private playing = false;

  constructor(
    createContext: (sampleRate?: number) => AudioContext = (sampleRate) =>
      new AudioContext(sampleRate ? { sampleRate } : undefined),
  ) {
    this.createContext = createContext;
    this.initContext();
  }

  private initContext(sampleRate?: number): void {
    this.audioContext = this.createContext(sampleRate);
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
  }

  setSampleRate(sampleRate: number): void {
    if (this.initialized) return;
    this.initialized = true;
    void this.audioContext.close();
    this.initContext(sampleRate);
  }

  get currentTime(): number {
    if (this.playing) {
      return this.timelineStartTime + (this.audioContext.currentTime - this.audioStartTime);
    }
    return this.timelineStartTime;
  }

  /** Context time at which timeline time `t` will be heard, on the clock
   *  `play`/`seekAll` last stamped. Only meaningful while playing. */
  contextTimeFor(timelineTime: number): number {
    return this.audioStartTime + (timelineTime - this.timelineStartTime);
  }

  async play(timelineTime: number): Promise<void> {
    // Stamp the clock BEFORE resuming: `currentTime` is frozen while the
    // context is suspended, so anything scheduled against the frozen value
    // plays the moment it resumes — and the first ticks (which land before
    // resume() settles) already map timeline → context time correctly.
    this.timelineStartTime = timelineTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.playing = true;
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  pause(): void {
    this.timelineStartTime = this.currentTime;
    this.playing = false;
    this.clearScrub();
    for (const state of this.clips.values()) {
      this.doStop(state);
    }
    void this.audioContext.suspend();
  }

  seekAll(timelineTime: number): void {
    this.timelineStartTime = timelineTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.clearScrub();
    for (const state of this.clips.values()) {
      this.doStop(state);
    }
  }

  registerClip(
    id: string,
    sink: AudioBufferSink,
    speed: number,
    volume: number = 1,
    pitch: number = 0
  ): void {
    // Idempotent: re-registering an id (or a stale one that lingers after a
    // timeline rebuild) must tear the old clip down first, or its GainNode
    // stays connected to masterGain and the audio graph grows without bound.
    if (this.clips.has(id)) this.unregisterClip(id);
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(this.masterGain);
    const pitchShifter = pitch !== 0 ? createPitchShifter(this.audioContext, pitch) : null;
    if (pitchShifter) pitchShifter.output.connect(gainNode);
    this.clips.set(id, {
      id,
      sink,
      speed,
      pitchShifter,
      sourceTarget: pitchShifter ? pitchShifter.input : gainNode,
      volume,
      appliedGain: volume,
      gainNode,
      iterator: null,
      run: null,
      queuedNodes: new Set(),
      asyncId: 0,
    });
  }

  /** Update a clip's per-frame volume. `volume` is the steady-state target
   *  (animated keyframe × composition volume); `fade` is the transient
   *  crossfade multiplier (0..1) applied on top. Only `volume` is recorded as
   *  the steady state — the fade must NOT pollute it, or `startClip` would
   *  restore a faded-out clip to near-silence on its next play. Skips if a
   *  scrub is in flight so the scrub's scheduled fade isn't clobbered. */
  setClipVolume(id: string, volume: number, fade: number = 1): void {
    const state = this.clips.get(id);
    if (!state) return;
    if (this.scrubActive.has(id)) {
      // The scrub will restore to the (now updated) steady-state itself.
      state.volume = volume;
      return;
    }
    state.volume = volume;
    const target = volume * fade;
    if (state.appliedGain === target) return;
    state.appliedGain = target;
    const now = this.audioContext.currentTime;
    const g = state.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(target, now);
  }

  unregisterClip(id: string): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);
    this.scrubActive.delete(id);
    state.pitchShifter?.dispose();
    state.gainNode.disconnect();
    this.clips.delete(id);
  }

  /** Stop + disconnect every registered clip. Called when the timeline is
   *  rebuilt (e.g. every resize-drag tick) so churned clips don't accumulate
   *  connected GainNodes/sinks in the audio graph and starve playback. */
  unregisterAll(): void {
    for (const id of [...this.clips.keys()]) this.unregisterClip(id);
  }

  /** Play a clip's audio from `sourceTime`, heard at `opts.at` (default now)
   *  and stopping at `opts.until` (default: when stopped). */
  startClip(id: string, sourceTime: number, opts: StartClipOptions = {}): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);

    // Clear any leftover scrub/crossfade automation so we start at the clip's
    // configured steady-state volume (not a stale faded-out value).
    const ctxNow = this.audioContext.currentTime;
    state.gainNode.gain.cancelScheduledValues(ctxNow);
    state.gainNode.gain.setValueAtTime(state.volume, ctxNow);
    state.appliedGain = state.volume;

    this.beginRun(state, {
      at: opts.at ?? ctxNow,
      sourceTime,
      until: opts.until ?? null,
      scrub: null,
      firstBufferAt: null,
      startedWall: now(),
    });
  }

  stopClip(id: string): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);
  }

  private beginRun(state: ClipState, run: Run): void {
    state.asyncId++;
    const myAsyncId = state.asyncId;
    state.run = run;
    state.iterator = state.sink.buffers(run.sourceTime)[Symbol.asyncIterator]();
    void this.pump(state, myAsyncId, run);
  }

  // ── Scrubbing ────────────────────────────────────────────────────

  /** In-flight scrub bursts by clip id. */
  private scrubActive = new Map<string, { state: ClipState; run: Run }>();
  /** Bumped per scrub() call so a burst waiting on `resume()` is dropped
   *  when a newer one supersedes it. */
  private scrubGen = 0;

  /**
   * Briefly play audio from the given per-clip source times, then stop after
   * `durationMs`. The burst is anchored to the moment its first decoded
   * buffer arrives (not to this call): a fresh decoder can take longer than
   * the whole burst to yield, and anchoring here would fade the gain to zero
   * before any sample plays. A tiny ramp (≈1 ms) at both ends on each clip's
   * gain node keeps starts and stops click-free. Calling scrub() again fades
   * out any previous burst (or silently drops one that hasn't sounded yet).
   */
  scrub(
    targets: Array<{ id: string; sourceTime: number }>,
    durationMs: number
  ): void {
    if (this.playing) return;
    this.clearScrub();
    if (targets.length === 0) return;

    const gen = ++this.scrubGen;
    const go = () => {
      if (gen !== this.scrubGen) return;
      for (const { id, sourceTime } of targets) {
        const state = this.clips.get(id);
        if (!state) continue;
        this.doStop(state);
        const run: Run = {
          at: this.audioContext.currentTime, // re-anchored on first buffer
          sourceTime,
          until: null,
          scrub: { durationSec: durationMs / 1000, finalizeTimer: null },
          firstBufferAt: null,
          startedWall: now(),
        };
        this.scrubActive.set(id, { state, run });
        this.beginRun(state, run);
      }
    };

    if (this.audioContext.state === "suspended") {
      // Paused → suspended context. Decoding can start now, but the burst's
      // clock only runs once the hardware stream is back, so wait for it —
      // otherwise a wall-clock finalize could fire before anything played.
      void this.audioContext.resume().then(go);
    } else {
      go();
    }
  }

  /** First buffer of a scrub burst landed: anchor the burst here. */
  private armScrub(state: ClipState, run: Run, ctxNow: number): void {
    const id = state.id;
    const scrub = run.scrub!;
    const fadeTime = 0.001;
    const startedAt = ctxNow;
    const endsAt = startedAt + scrub.durationSec;
    // Steady-state start time; clamped so very short bursts still get both fades
    const steadyEnd = Math.max(startedAt + fadeTime, endsAt - fadeTime);
    run.at = startedAt;
    run.until = endsAt;

    // Fade in → hold → fade out on the clip's gain node, then restore to the
    // clip's steady-state volume so future normal playback isn't silenced by
    // leftover automation.
    const g = state.gainNode.gain;
    const v = state.volume;
    g.cancelScheduledValues(startedAt);
    g.setValueAtTime(0, startedAt);
    g.linearRampToValueAtTime(v, startedAt + fadeTime);
    g.setValueAtTime(v, steadyEnd);
    g.linearRampToValueAtTime(0, endsAt);
    g.setValueAtTime(v, endsAt + 0.001);

    // Hard stop slightly after the scheduled fade-out ends so nothing lingers.
    scrub.finalizeTimer = setTimeout(() => {
      scrub.finalizeTimer = null;
      if (this.scrubActive.get(id)?.run !== run) return;
      this.scrubActive.delete(id);
      const t = this.audioContext.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(state.volume, t);
      state.appliedGain = state.volume;
      this.doStop(state);
    }, scrub.durationSec * 1000 + 2);
  }

  /**
   * Interrupt every in-flight scrub: a burst that has sounded gets a short
   * fade-out with its source-node stop delayed until the fade completes; one
   * still waiting on its first buffer is simply dropped (nothing to fade).
   * Used when a new scrub (or a play/pause/seek) supersedes the current one.
   */
  private clearScrub(): void {
    this.scrubGen++;
    if (this.scrubActive.size === 0) return;

    const ctx = this.audioContext;
    const ctxNow = ctx.currentTime;
    const fadeTime = 5 / ctx.sampleRate;
    const stopAt = ctxNow + fadeTime;

    for (const { state, run } of this.scrubActive.values()) {
      if (run.scrub?.finalizeTimer != null) {
        clearTimeout(run.scrub.finalizeTimer);
        run.scrub.finalizeTimer = null;
      }
      if (run.firstBufferAt == null) {
        this.doStop(state);
        continue;
      }
      const g = state.gainNode.gain;
      // Hold whatever value the ramp is at right now, then ramp it to 0.
      // cancelAndHoldAtTime is the modern API; fall back if unsupported.
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(ctxNow);
      } else {
        g.cancelScheduledValues(ctxNow);
      }
      g.linearRampToValueAtTime(0, stopAt);
      g.setValueAtTime(state.volume, stopAt + 0.001);
      state.appliedGain = state.volume;
      this.doStop(state, stopAt);
    }
    this.scrubActive.clear();
  }

  private doStop(state: ClipState, when?: number): void {
    state.asyncId++;
    void state.iterator?.return?.();
    state.iterator = null;
    state.run = null;
    for (const node of state.queuedNodes) {
      try {
        if (when != null) node.stop(when);
        else node.stop();
      } catch {
        // stop() throws if already stopped; ignore.
      }
    }
    state.queuedNodes.clear();
  }

  private async pump(state: ClipState, myAsyncId: number, run: Run): Promise<void> {
    const ctx = this.audioContext;

    while (true) {
      const iterator = state.iterator;
      if (!iterator || state.asyncId !== myAsyncId) return;
      const result = await iterator.next();
      if (state.asyncId !== myAsyncId || !result.value) return;

      const { buffer, timestamp } = result.value;
      const ctxNow = ctx.currentTime;

      if (run.scrub && run.firstBufferAt == null) {
        this.armScrub(state, run, ctxNow);
      }

      // When should this buffer be heard?
      const delay = (timestamp - run.sourceTime) / state.speed;
      const audioCtxTime = run.at + delay;
      if (run.until != null && audioCtxTime >= run.until) {
        // Past the clip's end — nothing more to schedule.
        void iterator.return?.();
        if (state.iterator === iterator) state.iterator = null;
        return;
      }

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = state.speed;
      node.connect(state.sourceTarget);

      // Earliest the buffer can start: its scheduled time, or now if that has
      // passed (late decode) — skipping the elapsed portion keeps sync. A
      // pre-rolled run (`at` in the future) likewise skips the part of the
      // buffer that precedes `sourceTime`.
      const startRef = Math.max(run.at, ctxNow);
      let started = false;
      if (audioCtxTime >= startRef) {
        node.start(audioCtxTime);
        started = true;
      } else {
        const offset = startRef - audioCtxTime; // output seconds already elapsed
        if (offset < buffer.duration / state.speed) {
          node.start(startRef, offset * state.speed);
          started = true;
        }
      }

      if (!started) {
        node.disconnect();
        continue;
      }
      if (run.until != null) node.stop(run.until);

      if (run.firstBufferAt == null) {
        run.firstBufferAt = ctxNow;
        this.lastStartLatencyMs = now() - run.startedWall;
        if (AudioScheduler.debug) {
          console.debug(
            `[audio] ${run.scrub ? "scrub" : "start"} ${state.id}: first buffer after ${this.lastStartLatencyMs.toFixed(1)} ms` +
              (run.scrub ? "" : `, scheduled ${((audioCtxTime - ctxNow) * 1000).toFixed(0)} ms ahead`),
          );
        }
      }

      state.queuedNodes.add(node);
      node.onended = () => state.queuedNodes.delete(node);

      // Throttle: if we're more than 1s ahead, wait
      const realTimeAhead = audioCtxTime - ctx.currentTime;
      if (realTimeAhead > 1) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, (realTimeAhead - 0.5) * 1000)),
        );
        if (state.asyncId !== myAsyncId) return;
      }
    }
  }

  dispose(): void {
    for (const [id] of this.clips) {
      this.unregisterClip(id);
    }
    this.initialized = false;
    void this.audioContext.close();
  }
}
