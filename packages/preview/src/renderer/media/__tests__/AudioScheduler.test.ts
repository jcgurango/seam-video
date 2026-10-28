import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioBufferSink } from "mediabunny";
import { AudioScheduler } from "../AudioScheduler.js";

// ── Fake Web Audio ──────────────────────────────────────────────────
// Just enough of the API for the scheduler: a settable clock, gain params
// that record their automation, buffer sources that record start/stop.

interface ParamEvent {
  type: string;
  value?: number;
  time: number;
}

class FakeParam {
  value = 1;
  events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "ramp", value, time });
  }
  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancel", time });
  }
  cancelAndHoldAtTime(time: number) {
    this.events.push({ type: "hold", time });
  }
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
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
  sampleRate = 48000;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
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

/** A sink whose buffers are released one at a time by the test, emulating
 *  decode latency. Like mediabunny, `buffers(t)` starts with the buffer that
 *  contains `t`. */
function makeSink(items: Array<{ timestamp: number; duration: number }>) {
  const waits: Array<() => void> = [];
  const sink = {
    calls: [] as number[],
    /** Let the next pending buffer through. */
    release() {
      waits.shift()?.();
    },
    get pending() {
      return waits.length;
    },
    async *buffers(start: number) {
      sink.calls.push(start);
      for (const it of items) {
        if (it.timestamp + it.duration <= start) continue;
        await new Promise<void>((r) => waits.push(r));
        yield {
          buffer: { duration: it.duration } as AudioBuffer,
          timestamp: it.timestamp,
          duration: it.duration,
        };
      }
    },
  };
  return sink;
}

/** Drain microtasks + one macrotask so the pump reacts to a released buffer. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const PACKET = 1024 / 48000; // one AAC packet ≈ 21.3 ms
const packetsFrom = (t0: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: t0 + i * PACKET, duration: PACKET }));

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

const clipGain = () => ctx.gains[1]; // gains[0] is the master
/** Source nodes that were actually started (the pump discards fully-elapsed ones). */
const started = () => ctx.sources.filter((s) => s.starts.length > 0);

describe("scrub", () => {
  it("anchors the burst to the first buffer's arrival, not to the call", async () => {
    // Packets straddling source time 1.0: the one containing it starts at 0.98.
    const sink = makeSink(packetsFrom(1.0 - PACKET + 0.0013, 6));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);

    scheduler.scrub([{ id: "a", sourceTime: 1.0 }], 30);
    expect(sink.calls).toEqual([1.0]);
    // Nothing is scheduled and the gain is untouched while decode is pending.
    expect(ctx.sources).toHaveLength(0);
    expect(clipGain().gain.events).toEqual([]);

    // Decode takes 80 ms — longer than the whole 30 ms burst.
    ctx.currentTime = 0.08;
    sink.release();
    await flush();

    const [node] = ctx.sources;
    expect(node).toBeDefined();
    const ts = 1.0 - PACKET + 0.0013;
    // Plays right now from the offset of sourceTime inside the buffer…
    expect(node.starts).toEqual([{ when: 0.08, offset: expect.closeTo(1.0 - ts, 9) }]);
    // …and stops at the burst's end, measured from arrival.
    expect(node.stops).toEqual([expect.closeTo(0.11, 9)]);
    // Envelope: fade in at 0.08, hold, fade out ending at 0.11, restore.
    const ev = clipGain().gain.events;
    expect(ev.map((e) => e.type)).toEqual(["cancel", "set", "ramp", "set", "ramp", "set"]);
    expect(ev[1]).toEqual({ type: "set", value: 0, time: 0.08 });
    expect(ev[4]).toEqual({ type: "ramp", value: 0, time: expect.closeTo(0.11, 9) });
    expect(scheduler.lastStartLatencyMs).not.toBeNull();

    // Subsequent buffers chain off the re-anchored start and stop at `until`.
    sink.release();
    await flush();
    expect(ctx.sources[1].starts[0].when).toBeCloseTo(0.08 + (ts + PACKET - 1.0), 9);
    expect(ctx.sources[1].stops).toEqual([expect.closeTo(0.11, 9)]);
    // Buffers past the burst end aren't scheduled; the pump stops pulling.
    sink.release();
    await flush();
    sink.release();
    await flush();
    expect(ctx.sources.length).toBeLessThanOrEqual(3);

    // The finalize timer restores the steady-state gain and hard-stops.
    vi.advanceTimersByTime(40);
    const last = clipGain().gain.events.at(-1)!;
    expect(last).toMatchObject({ type: "set", value: 1 });
    for (const s of ctx.sources) expect(s.stops.length).toBeGreaterThanOrEqual(1);
  });

  it("drops a burst superseded before any audio arrived, without automation", async () => {
    const sink = makeSink(packetsFrom(0.5, 10));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);

    scheduler.scrub([{ id: "a", sourceTime: 0.5 }], 30);
    ctx.currentTime = 0.01;
    scheduler.scrub([{ id: "a", sourceTime: 0.6 }], 30); // next pointermove
    expect(sink.calls).toEqual([0.5, 0.6]);

    // The first iterator's buffer lands late: it must be ignored, with no
    // fade-out automation written for a burst that never sounded.
    sink.release();
    await flush();
    expect(started()).toHaveLength(0);
    expect(clipGain().gain.events).toEqual([]);

    // The second burst sounds normally.
    ctx.currentTime = 0.05;
    sink.release();
    await flush();
    expect(started()).toHaveLength(1);
    expect(started()[0].starts[0].when).toBe(0.05);
  });

  it("fades out a burst that has sounded when a new one arrives", async () => {
    const sink = makeSink(packetsFrom(0.5, 4));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);
    scheduler.scrub([{ id: "a", sourceTime: 0.5 }], 30);
    sink.release();
    await flush();
    expect(ctx.sources).toHaveLength(1);

    ctx.currentTime = 0.01;
    scheduler.scrub([{ id: "a", sourceTime: 0.7 }], 30);
    const stopAt = 0.01 + 5 / 48000;
    expect(ctx.sources[0].stops.at(-1)).toBeCloseTo(stopAt, 9);
    const ev = clipGain().gain.events;
    expect(ev.at(-2)).toEqual({ type: "ramp", value: 0, time: expect.closeTo(stopAt, 9) });
  });

  it("waits for a suspended context to resume before starting", async () => {
    const sink = makeSink(packetsFrom(0.5, 4));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);
    ctx.state = "suspended";
    scheduler.scrub([{ id: "a", sourceTime: 0.5 }], 30);
    expect(sink.calls).toEqual([]);
    await flush();
    expect(ctx.state).toBe("running");
    expect(sink.calls).toEqual([0.5]);
  });
});

describe("playback runs", () => {
  it("pre-rolls: buffers queue at their future context times and stop at `until`", async () => {
    const sink = makeSink(packetsFrom(2.0 - PACKET + 0.002, 40));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);
    void scheduler.play(0);

    // Clip starts 0.5 s from now, ends 0.3 s later; its source in is 2.0.
    scheduler.startClip("a", 2.0, { at: 0.5, until: 0.8 });
    const ts0 = 2.0 - PACKET + 0.002;

    sink.release();
    await flush();
    // The buffer containing the in point starts exactly at the clip's start,
    // offset so the sample at sourceTime is the first one heard.
    expect(ctx.sources[0].starts).toEqual([{ when: 0.5, offset: expect.closeTo(2.0 - ts0, 9) }]);
    expect(ctx.sources[0].stops).toEqual([0.8]);

    sink.release();
    await flush();
    expect(ctx.sources[1].starts).toEqual([{ when: expect.closeTo(0.5 + (ts0 + PACKET - 2.0), 9), offset: undefined }]);
    expect(ctx.sources[1].stops).toEqual([0.8]);

    // Keep releasing: nothing is scheduled at/after `until`, and the pump
    // stops pulling (no further pending waits are consumed).
    for (let i = 0; i < 40; i++) {
      sink.release();
      await flush();
    }
    const lastStart = Math.max(...ctx.sources.map((s) => s.starts[0].when));
    expect(lastStart).toBeLessThan(0.8);
    expect(ctx.sources.length).toBeLessThan(20);
  });

  it("a late first buffer skips the elapsed portion so audio stays in sync", async () => {
    const ts0 = 5.0 - PACKET + 0.005;
    const sink = makeSink(packetsFrom(ts0, 6));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 1);
    void scheduler.play(0);
    scheduler.startClip("a", 5.0); // at = now = 0

    // 50 ms pass before the decoder yields anything: the first packets are
    // fully elapsed and must be dropped, the first one still partly in the
    // future starts now at the offset that keeps it on the clock.
    ctx.currentTime = 0.05;
    for (let i = 0; i < 4; i++) {
      sink.release();
      await flush();
    }
    const first = started();
    expect(first).toHaveLength(1);
    const tsHeard = [0, 1, 2, 3].map((i) => ts0 + i * PACKET).find((ts) => ts - 5.0 + PACKET > 0.05)!;
    const scheduledAt = tsHeard - 5.0; // where it should have started
    expect(first[0].starts).toEqual([
      { when: 0.05, offset: expect.closeTo(0.05 - scheduledAt, 9) },
    ]);
  });

  it("honours speed when mapping source offsets to context time", async () => {
    const sink = makeSink(packetsFrom(1.0, 6));
    scheduler.registerClip("a", sink as unknown as AudioBufferSink, 2);
    void scheduler.play(0);
    scheduler.startClip("a", 1.0, { at: 1.0 });
    sink.release();
    await flush();
    sink.release();
    await flush();
    expect(ctx.sources[0].starts[0]).toEqual({ when: 1.0, offset: undefined });
    // Source advances 2× faster than output: the next packet is PACKET/2 later.
    expect(ctx.sources[1].starts[0].when).toBeCloseTo(1.0 + PACKET / 2, 9);
    expect(ctx.sources[1].playbackRate.value).toBe(2);
  });

  it("play() stamps the clock before the context resumes", async () => {
    ctx.state = "suspended";
    ctx.currentTime = 7;
    const p = scheduler.play(3);
    expect(scheduler.contextTimeFor(3.5)).toBe(7.5);
    expect(scheduler.currentTime).toBe(3);
    await p;
    expect(ctx.state).toBe("running");
  });
});
