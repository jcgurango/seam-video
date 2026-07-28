import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";
import type {
  Child,
  ResolvedTimeline,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import { applyBracket } from "../bracketTool.js";

const resolve = (doc: SeamFile): ResolvedTimeline =>
  resolveSpatial(
    resolveComposition(doc),
    DEFAULT_CANVAS_WIDTH,
    DEFAULT_CANVAS_HEIGHT,
  );

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", ...fields }) as unknown as Child;

const anchorOf = (node: Child | undefined, side: "start" | "end") =>
  (node as { start?: TimeAnchor; end?: TimeAnchor } | undefined)?.[side];

describe("applyBracket — attached to the primary", () => {
  it("bracket start with a start anchor: shifts the offset so starts align", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "A", in: 0, out: 10 })],
      attachments: [
        clip({
          in: 0,
          out: 2,
          start: { anchor: "A", timeSource: "source", anchorPoint: 5, offset: 0 },
        }),
      ],
    };
    const next = applyBracket(doc, resolve(doc), 0, "children.0", ["attachments.0"], "start");
    expect(next).not.toBeNull();
    expect(anchorOf(next!.attachments![0], "start")!.offset).toBe(-5);
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(r.children[0].timelineStart);
  });

  it("bracket end with an end anchor: shifts the offset so ends align", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "A", in: 0, out: 10 })],
      attachments: [
        clip({
          in: 0,
          out: 2,
          end: { anchor: "A", timeSource: "source", anchorPoint: 5, offset: 0 },
        }),
      ],
    };
    const next = applyBracket(doc, resolve(doc), 0, "children.0", ["attachments.0"], "end");
    expect(anchorOf(next!.attachments![0], "end")!.offset).toBe(5);
    const r = resolve(next!);
    expect(r.children[1].timelineEnd).toBe(r.children[0].timelineEnd);
  });

  it("bracket start without a start anchor: left-resizes, speed-aware", () => {
    // B is end-anchored at output 5 with speed 0.5 (output dur 3 → spans
    // [2, 5]). Bracketing start to A's start (0) needs 2 more output
    // seconds = 1 source second: in 2 → 1.
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "A", in: 0, out: 10 })],
      attachments: [
        clip({
          in: 2,
          out: 3.5,
          speed: 0.5,
          end: { anchor: "A", timeSource: "source", anchorPoint: 5, offset: 0 },
        }),
      ],
    };
    const next = applyBracket(doc, resolve(doc), 0, "children.0", ["attachments.0"], "start");
    const att = next!.attachments![0] as Child & { in: number };
    expect(att.in).toBe(1);
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(0);
    expect(r.children[1].timelineEnd).toBe(5);
  });
});

describe("applyBracket — legato (primary not the anchor)", () => {
  const legatoDoc = (secondary: Child): SeamFile => ({
    type: "composition",
    children: [clip({ in: 0, out: 5 }), clip({ id: "A", in: 0, out: 5 })],
    attachments: [secondary],
  });

  it("bracket end with an end anchor: end meets the primary's start", () => {
    // Primary A spans [5, 10]; B ends at 3 → offset shifts by +2.
    const doc = legatoDoc(clip({ in: 0, out: 2, end: { offset: 3 } }));
    const next = applyBracket(doc, resolve(doc), 0, "children.1", ["attachments.0"], "end");
    expect(anchorOf(next!.attachments![0], "end")!.offset).toBe(5);
    const r = resolve(next!);
    expect(r.children[2].timelineEnd).toBe(5);
  });

  it("bracket end without an end anchor: right-resizes to the primary's start", () => {
    const doc = legatoDoc(clip({ in: 0, out: 2, start: { offset: 1 } }));
    const next = applyBracket(doc, resolve(doc), 0, "children.1", ["attachments.0"], "end");
    expect((next!.attachments![0] as Child & { out: number }).out).toBe(4);
    const r = resolve(next!);
    expect(r.children[2].timelineStart).toBe(1);
    expect(r.children[2].timelineEnd).toBe(5);
  });

  it("bracket start: start meets the primary's end", () => {
    const doc = legatoDoc(clip({ in: 0, out: 2, start: { offset: 1 } }));
    const next = applyBracket(doc, resolve(doc), 0, "children.1", ["attachments.0"], "start");
    expect(anchorOf(next!.attachments![0], "start")!.offset).toBe(10);
    const r = resolve(next!);
    expect(r.children[2].timelineStart).toBe(10);
  });

  it("converts the delta into a nested container's local time scale", () => {
    // C is a 2x comp spanning [10, 15]; its attachment B sits at local
    // [2, 4] (global [11, 12]). Bracket start against root child A (ends at
    // global 10) must move B's local start to 0 — a local delta of −2 for a
    // global delta of −1.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "A", in: 0, out: 10 }),
        {
          type: "composition",
          speed: 2,
          children: [clip({ in: 0, out: 10 })],
          attachments: [clip({ in: 0, out: 2, start: { offset: 2 } })],
        } as unknown as Child,
      ],
    };
    const next = applyBracket(
      doc,
      resolve(doc),
      0,
      "children.0",
      ["children.1.attachments.0"],
      "start",
    );
    const nested = next!.children![1] as unknown as SeamFile;
    expect(anchorOf(nested.attachments![0], "start")!.offset).toBe(0);
    const r = resolve(next!);
    const rNested = r.children[1] as unknown as { children: { timelineStart: number }[] };
    expect(rNested.children[1].timelineStart).toBe(0);
  });

  it("no-ops (returns null) when everything is already in place", () => {
    // B already ends exactly at the primary's start.
    const doc = legatoDoc(clip({ in: 0, out: 2, end: { offset: 5 } }));
    const next = applyBracket(doc, resolve(doc), 0, "children.1", ["attachments.0"], "end");
    expect(next).toBeNull();
  });
});

describe("applyBracket — primary only, against the playhead", () => {
  it("bracket start with a start anchor: shifts the offset to the playhead", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ id: "A", in: 0, out: 10 })],
      attachments: [
        clip({
          in: 0,
          out: 2,
          start: { anchor: "A", timeSource: "source", anchorPoint: 5, offset: 0 },
        }),
      ],
    };
    // B starts at 5; playhead at 7 → offset +2.
    const next = applyBracket(doc, resolve(doc), 7, "attachments.0", [], "start");
    expect(anchorOf(next!.attachments![0], "start")!.offset).toBe(2);
    const r = resolve(next!);
    expect(r.children[1].timelineStart).toBe(7);
  });

  it("bracket end without an end anchor: right-resizes to the playhead, speed-aware", () => {
    // A 2x clip spanning [0, 2]; playhead at 3 → +1s of output = +2s of
    // source on `out`.
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ in: 0, out: 4, speed: 2 })],
    };
    const next = applyBracket(doc, resolve(doc), 3, "children.0", [], "end");
    expect((next!.children![0] as Child & { out: number }).out).toBe(6);
    const r = resolve(next!);
    expect(r.children[0].timelineEnd).toBe(3);
  });

  it("maps the playhead into a nested primary's container-local time", () => {
    // C is a 2x comp spanning [10, 15]; its attachment B sits at local
    // [2, 4]. Playhead at global 11 = local 2 → bracket end pulls B's end
    // (local 4) back by a local delta of −2: out 2 → 0.
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ in: 0, out: 10 }),
        {
          type: "composition",
          speed: 2,
          children: [clip({ in: 0, out: 10 })],
          attachments: [clip({ in: 0, out: 2, start: { offset: 2 } })],
        } as unknown as Child,
      ],
    };
    const next = applyBracket(
      doc,
      resolve(doc),
      11,
      "children.1.attachments.0",
      [],
      "end",
    );
    const nested = next!.children![1] as unknown as SeamFile;
    expect((nested.attachments![0] as Child & { out: number }).out).toBe(0);
  });

  it("no-ops (returns null) when the edge is already at the playhead", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({ in: 0, out: 5 })],
    };
    expect(applyBracket(doc, resolve(doc), 5, "children.0", [], "end")).toBeNull();
  });
});
