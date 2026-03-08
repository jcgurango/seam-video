import type { AudioBufferSink } from "mediabunny";

interface ClipState {
  sink: AudioBufferSink;
  speed: number;
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
    for (const state of this.clips.values()) {
      this.doStop(state);
    }
    void this.audioContext.suspend();
  }

  seekAll(timelineTime: number): void {
    this.timelineStartTime = timelineTime;
    this.audioStartTime = this.audioContext.currentTime;
    for (const state of this.clips.values()) {
      this.doStop(state);
    }
  }

  registerClip(id: string, sink: AudioBufferSink, speed: number): void {
    const gainNode = this.audioContext.createGain();
    gainNode.connect(this.masterGain);
    this.clips.set(id, {
      sink,
      speed,
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

    state.asyncId++;
    const myAsyncId = state.asyncId;
    const startedAt = this.audioContext.currentTime;

    state.iterator = state.sink.buffers(sourceTime)[Symbol.asyncIterator]();
    void this.pump(state, myAsyncId, sourceTime, startedAt);
  }

  stopClip(id: string): void {
    const state = this.clips.get(id);
    if (!state) return;
    this.doStop(state);
  }

  private doStop(state: ClipState): void {
    state.asyncId++;
    void state.iterator?.return?.();
    state.iterator = null;
    for (const node of state.queuedNodes) {
      node.stop();
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
