import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioBufferSink } from "mediabunny";
import { AudioScheduler } from "../AudioScheduler.js";

// Reversed clips (`registerClip(..., reverse = true)`): the scheduler walks
// down the source axis in chunks, decoding each forward and scheduling it
// sample-reversed. The fake source's sample value IS its sample index, so a
// scheduled buffer's contents name the source samples it plays, in order.

const SR = 1000;
const PACKET = 100; // samples per decoded buffer

class FakeBuffer {
  readonly data: Float32Array;
  readonly numberOfChannels = 1;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData() {
    return this.data;
  }
}

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
  cancelAndHoldAtTime() {}
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate = { value: 1 };
  starts: Array<{ when: number; offset: number | undefined }> = [];
  stops: Array<number | undefined> = [];
  onended: (() => void) | null = null;
  start(when: number, offset?: number) {
    this.starts.push({ when, offset });
  }
  stop(when?: number) {
    this.stops.push(when);
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = SR;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  sources: FakeSource[] = [];
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(length, sampleRate);
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.state = "closed";
  }
}

/** A `seconds`-long source in PACKET-sample buffers; like mediabunny,
 *  `buffers(start, end)` yields from the buffer containing `start` up to
 *  (not including) one starting at/after `end`. */
function makeSink(seconds: number) {
  const total = seconds * SR;
  const sink = {
    calls: [] as Array<[number, number]>,
    async *buffers(start: number, end: number) {
      sink.calls.push([start, end]);
      for (let s0 = 0; s0 < total; s0 += PACKET) {
        if ((s0 + PACKET) / SR <= start) continue;
        if (s0 / SR >= end) return;
        const buffer = new FakeBuffer(PACKET, SR);
        for (let i = 0; i < PACKET; i++) buffer.data[i] = s0 + i;
        yield { buffer: buffer as unknown as AudioBuffer, timestamp: s0 / SR, duration: PACKET / SR };
      }
    },
  };
  return sink;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

let ctx: FakeContext;
let scheduler: AudioScheduler;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  ctx = new FakeContext();
  scheduler = new AudioScheduler(() => ctx as unknown as AudioContext);
});

afterEach(() => {
  vi.useRealTimers();
});

const firstLast = (s: FakeSource) => [s.buffer!.data[0], s.buffer!.data[s.buffer!.length - 1]];

describe("reversed playback runs", () => {
  it("schedules sample-reversed chunks walking down the source, abutting exactly", async () => {
    const sink = makeSink(4);
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1, 1, 0, true);
    void scheduler.play(0);
    // Starts 0.5 s from now at source 2.0, runs 1 s (to source 1.0).
    scheduler.startClip("a", 2.0, { at: 0.5, until: 1.5 });
    await flush();

    // Short first chunk [1.75, 2.0], then 1 s chunks; the one that would
    // start at/after `until` is never decoded.
    expect(sink.calls).toEqual([
      [1.75, 2.0],
      [0.75, 1.75],
    ]);
    expect(ctx.sources).toHaveLength(2);
    const [a, b] = ctx.sources;
    expect(a.starts).toEqual([{ when: 0.5, offset: undefined }]);
    expect(firstLast(a)).toEqual([1999, 1750]);
    expect(a.buffer!.length).toBe(250);
    expect(b.starts).toEqual([{ when: 0.75, offset: undefined }]);
    expect(firstLast(b)).toEqual([1749, 750]);
    expect(a.stops).toEqual([1.5]);
    expect(b.stops).toEqual([1.5]);
  });

  it("honours speed: chunks land closer together and play faster", async () => {
    const sink = makeSink(4);
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 2, 1, 0, true);
    void scheduler.play(0);
    scheduler.startClip("a", 3.0, { at: 1.0, until: 1.6 });
    await flush();
    expect(ctx.sources[0].starts[0].when).toBe(1.0);
    // 0.25 source-seconds at 2× = 0.125 s of output.
    expect(ctx.sources[1].starts[0].when).toBeCloseTo(1.125, 9);
    expect(ctx.sources[1].playbackRate.value).toBe(2);
    expect(firstLast(ctx.sources[1])).toEqual([2749, 1750]);
  });

  it("a late start skips the elapsed head of the chunk", async () => {
    const sink = makeSink(4);
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1, 1, 0, true);
    void scheduler.play(0);
    ctx.currentTime = 0.1;
    // Should have started at context 0 — 0.1 s ago.
    scheduler.startClip("a", 2.0, { at: 0 });
    await flush();
    expect(ctx.sources[0].starts).toEqual([{ when: 0.1, offset: expect.closeTo(0.1, 9) }]);
  });

  it("stops at the start of the source", async () => {
    const sink = makeSink(4);
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1, 1, 0, true);
    void scheduler.play(0);
    scheduler.startClip("a", 0.4, { at: 0 });
    await flush();
    expect(sink.calls).toEqual([
      [expect.closeTo(0.15, 9), 0.4],
      [0, expect.closeTo(0.15, 9)],
    ]);
    expect(firstLast(ctx.sources[1])).toEqual([149, 0]);
  });

  it("a scrub burst is one reversed chunk ending at the playhead", async () => {
    const sink = makeSink(4);
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1, 1, 0, true);
    scheduler.scrub([{ id: "a", sourceTime: 2.0 }], 30);
    await flush();
    expect(sink.calls).toHaveLength(1);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].buffer!.data[0]).toBe(1999);
    expect(ctx.sources[0].buffer!.duration).toBeGreaterThanOrEqual(0.03);
  });
});
