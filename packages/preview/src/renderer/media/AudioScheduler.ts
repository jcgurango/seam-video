import type { AudioBufferSink } from "mediabunny";

interface ClipState {
  sink: AudioBufferSink;
  speed: number;
  /** Per-clip volume multiplier; 1 = unity. Used as the steady-state value
   *  the gain node holds during normal playback / scrub fades. */
  volume: number;
  gainNode: GainNode;
  // Playback state (null when not playing)
  iterator: AsyncIterator<{ buffer: AudioBuffer; timestamp: number; duration: number }> | null;
  queuedNodes: Set<AudioBufferSourceNode>;
  asyncId: number;
}

export class AudioScheduler {
  audioContext!: AudioContext;
  private masterGain!: GainNode;
  private clips = new Map<string, ClipState>();
  private initialized = false;

  /** AudioContext.currentTime when play/seek last happened */
  private audioStartTime = 0;
  /** Timeline position when play/seek last happened */
  private timelineStartTime = 0;
  private playing = false;

  constructor() {
    this.initContext();
  }

  private initContext(sampleRate?: number): void {
    this.audioContext = new AudioContext(sampleRate ? { sampleRate } : undefined);
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

  async play(timelineTime: number): Promise<void> {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.timelineStartTime = timelineTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.playing = true;
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
    volume: number = 1
  ): void {
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(this.masterGain);
    this.clips.set(id, {
      sink,
      speed,
      volume,
      gainNode,
      iterator: null,
      queuedNodes: new Set(),
      asyncId: 0,
    });
  }

  unregisterClip(id: string): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);
    state.gainNode.disconnect();
    this.clips.delete(id);
  }

  /** Start playing a clip's audio from the given source time, right now. */
  startClip(id: string, sourceTime: number): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);

    // Clear any leftover scrub automation so we start at the clip's
    // configured steady-state volume.
    const now = this.audioContext.currentTime;
    state.gainNode.gain.cancelScheduledValues(now);
    state.gainNode.gain.setValueAtTime(state.volume, now);

    state.asyncId++;
    const myAsyncId = state.asyncId;
    const startedAt = now;

    state.iterator = state.sink.buffers(sourceTime)[Symbol.asyncIterator]();
    void this.pump(state, myAsyncId, sourceTime, startedAt);
  }

  stopClip(id: string): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);
  }

  // ── Scrubbing ────────────────────────────────────────────────────

  private scrubStopTimer: number | null = null;
  private scrubActiveIds = new Set<string>();

  /**
   * Briefly play audio from the given per-clip source times, then stop after
   * `durationMs`. Apply a tiny ramp (≈5 samples) at both ends on each clip's
   * gain node so starts and stops don't click. Calling scrub() again fades
   * out any previous scrub before starting the new one.
   */
  scrub(
    targets: Array<{ id: string; sourceTime: number }>,
    durationMs: number
  ): void {
    if (this.playing) return;
    this.clearScrub();
    if (targets.length === 0) return;

    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume();
    }

    const ctx = this.audioContext;
    const fadeTime = 0.001;
    const durationSec = durationMs / 1000;
    const startedAt = ctx.currentTime;
    const endsAt = startedAt + durationSec;
    // Steady-state start time; clamped so very short scrubs still get both fades
    const steadyEnd = Math.max(startedAt + fadeTime, endsAt - fadeTime);

    for (const { id, sourceTime } of targets) {
      const state = this.clips.get(id);
      if (!state) continue;
      this.doStop(state);

      // Fade in → hold → fade out on the clip's gain node, then restore to
      // the clip's steady-state volume so future normal playback isn't
      // silenced by leftover automation.
      const g = state.gainNode.gain;
      const v = state.volume;
      g.cancelScheduledValues(startedAt);
      g.setValueAtTime(0, startedAt);
      g.linearRampToValueAtTime(v, startedAt + fadeTime);
      g.setValueAtTime(v, steadyEnd);
      g.linearRampToValueAtTime(0, endsAt);
      g.setValueAtTime(v, endsAt + 0.001);

      state.asyncId++;
      const myAsyncId = state.asyncId;
      state.iterator = state.sink
        .buffers(sourceTime)
        [Symbol.asyncIterator]();
      void this.pump(state, myAsyncId, sourceTime, startedAt);
      this.scrubActiveIds.add(id);
    }

    // Hard stop slightly after the scheduled fade-out ends so nothing lingers.
    this.scrubStopTimer = window.setTimeout(() => {
      this.finalizeScrub();
    }, durationMs + 2);
  }

  /**
   * Clean up after a scrub whose fade-out has already played to 0. Simply
   * cancels pending automation and hard-stops source nodes (which are now
   * silent).
   */
  private finalizeScrub(): void {
    if (this.scrubStopTimer != null) {
      clearTimeout(this.scrubStopTimer);
      this.scrubStopTimer = null;
    }
    const now = this.audioContext.currentTime;
    for (const id of this.scrubActiveIds) {
      const state = this.clips.get(id);
      if (!state) continue;
      const g = state.gainNode.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(state.volume, now);
      this.doStop(state);
    }
    this.scrubActiveIds.clear();
  }

  /**
   * Interrupt an in-flight scrub: schedule a short fade-out, delay the
   * source-node stop until the fade completes, then reset the gain. Used when
   * a new scrub (or a play/pause/seek) supersedes the current one.
   */
  private clearScrub(): void {
    if (this.scrubStopTimer != null) {
      clearTimeout(this.scrubStopTimer);
      this.scrubStopTimer = null;
    }
    if (this.scrubActiveIds.size === 0) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const fadeTime = 5 / ctx.sampleRate;
    const stopAt = now + fadeTime;

    for (const id of this.scrubActiveIds) {
      const state = this.clips.get(id);
      if (!state) continue;
      const g = state.gainNode.gain;
      // Hold whatever value the ramp is at right now, then ramp it to 0.
      // cancelAndHoldAtTime is the modern API; fall back if unsupported.
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(now);
      } else {
        g.cancelScheduledValues(now);
      }
      g.linearRampToValueAtTime(0, stopAt);
      g.setValueAtTime(state.volume, stopAt + 0.001);
      this.doStop(state, stopAt);
    }
    this.scrubActiveIds.clear();
  }

  private doStop(state: ClipState, when?: number): void {
    state.asyncId++;
    void state.iterator?.return?.();
    state.iterator = null;
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

  private async pump(
    state: ClipState,
    myAsyncId: number,
    sourceTime: number,
    startedAt: number
  ): Promise<void> {
    if (!state.iterator) return;

    while (true) {
      const result = await state.iterator.next();
      if (state.asyncId !== myAsyncId || !result.value) return;

      const { buffer, timestamp } = result.value;

      // How far into the clip's playback should this buffer play?
      const delay = (timestamp - sourceTime) / state.speed;
      const audioCtxTime = startedAt + delay;

      const node = this.audioContext.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = state.speed;
      node.connect(state.gainNode);

      let started = false;
      if (audioCtxTime >= this.audioContext.currentTime) {
        node.start(audioCtxTime);
        started = true;
      } else {
        // Buffer is in the past — play the remaining portion
        const offset = this.audioContext.currentTime - audioCtxTime;
        if (offset < buffer.duration / state.speed) {
          node.start(this.audioContext.currentTime, offset * state.speed);
          started = true;
        }
      }

      if (!started) {
        node.disconnect();
        continue;
      }

      state.queuedNodes.add(node);
      node.onended = () => state.queuedNodes.delete(node);

      // Throttle: if we're more than 1s ahead, wait
      if (delay > 0) {
        const realTimeAhead = audioCtxTime - this.audioContext.currentTime;
        if (realTimeAhead > 1) {
          await new Promise<void>((resolve) => {
            const wait = Math.max(0, (realTimeAhead - 0.5) * 1000);
            const timer = setTimeout(resolve, wait);
            // Check if we were cancelled during the wait
            const check = setInterval(() => {
              if (state.asyncId !== myAsyncId) {
                clearTimeout(timer);
                clearInterval(check);
                resolve();
              }
            }, 100);
            setTimeout(() => clearInterval(check), wait + 100);
          });
          if (state.asyncId !== myAsyncId) return;
        }
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
