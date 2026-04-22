import { describe, it, expect } from "vitest";
import { inlineRefs } from "../inline.js";
import type { Composition, SeamFile } from "../types.js";
import { resolveComposition } from "../layout/resolve.js";

describe("inlineRefs", () => {
  it("is a no-op when there are no refs", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [{ type: "clip", source: "a.mp4", in: 0, out: 5 }],
    };
    const out = inlineRefs(doc);
    expect(out).toEqual(doc);
  });

  it("expands a simple ref to a composition wrapping the definition", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 5 },
        { type: "ref", source: "R", in: 0, out: 5 },
      ],
      refs: {
        R: { type: "clip", source: "c.mp4", in: 0, out: 5 },
      },
    };
    const out = inlineRefs(doc);
    expect(out.children).toHaveLength(2);
    expect((out as Composition).refs).toBeUndefined();

    const ref = out.children[1];
    expect(ref.type).toBe("composition");
    if (ref.type !== "composition") return;
    expect(ref.children).toHaveLength(1);
    expect(ref.children[0]).toEqual({
      type: "clip",
      source: "c.mp4",
      in: 0,
      out: 5,
    });
    expect(ref.in).toBe(0);
    expect(ref.out).toBe(5);
  });

  it("propagates the ref's timing fields to the wrapper", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        {
          type: "ref",
          source: "R",
          in: 1,
          out: 3,
          flex: 2,
          overflow: "trim-end",
        },
      ],
      refs: {
        R: { type: "clip", source: "c.mp4", in: 5, out: 10 },
      },
    };
    const out = inlineRefs(doc);
    const ref = out.children[0];
    expect(ref.type).toBe("composition");
    if (ref.type !== "composition") return;
    expect(ref.in).toBe(1);
    expect(ref.out).toBe(3);
    expect(ref.flex).toBe(2);
    expect(ref.overflow).toBe("trim-end");
  });

  it("looks up from the innermost scope first", () => {
    const doc: SeamFile = {
      type: "composition",
      refs: {
        R: { type: "clip", source: "outer.mp4", in: 0, out: 5 },
      },
      children: [
        {
          type: "composition",
          refs: {
            R: { type: "clip", source: "inner.mp4", in: 0, out: 5 },
          },
          children: [{ type: "ref", source: "R", in: 0, out: 5 }],
        },
      ],
    };
    const out = inlineRefs(doc);
    const outerChild = out.children[0];
    expect(outerChild.type).toBe("composition");
    if (outerChild.type !== "composition") return;
    // Inner ref should resolve to inner.mp4
    const ref = outerChild.children[0];
    expect(ref.type).toBe("composition");
    if (ref.type !== "composition") return;
    const def = ref.children[0];
    expect(def.type).toBe("clip");
    if (def.type !== "clip") return;
    expect(def.source).toBe("inner.mp4");
  });

  it("walks up the scope chain for refs not in the innermost", () => {
    const doc: SeamFile = {
      type: "composition",
      refs: {
        outerRef: { type: "clip", source: "outer.mp4", in: 0, out: 5 },
      },
      children: [
        {
          type: "composition",
          children: [{ type: "ref", source: "outerRef", in: 0, out: 5 }],
        },
      ],
    };
    const out = inlineRefs(doc);
    const inner = out.children[0];
    if (inner.type !== "composition") throw new Error();
    const ref = inner.children[0];
    if (ref.type !== "composition") throw new Error();
    const def = ref.children[0];
    if (def.type !== "clip") throw new Error();
    expect(def.source).toBe("outer.mp4");
  });

  it("resolves refs within a definition using the definition's authoring scope", () => {
    // compA defines X = ref(Y). Y is defined in compA. compB nested inside
    // compA also defines Y differently — but the X→Y chain should use
    // compA's Y, not compB's, because X was authored in compA's scope.
    const doc: SeamFile = {
      type: "composition",
      refs: {
        X: { type: "ref", source: "Y", in: 0, out: 5 },
        Y: { type: "clip", source: "compA-Y.mp4", in: 0, out: 5 },
      },
      children: [
        {
          type: "composition",
          refs: {
            Y: { type: "clip", source: "compB-Y.mp4", in: 0, out: 5 },
          },
          children: [{ type: "ref", source: "X", in: 0, out: 5 }],
        },
      ],
    };
    const out = inlineRefs(doc);
    const inner = out.children[0];
    if (inner.type !== "composition") throw new Error();
    // ref(X) → comp wrapping inlined X def
    const refX = inner.children[0];
    if (refX.type !== "composition") throw new Error();
    // X's def was ref(Y) → comp wrapping inlined Y def
    const refY = refX.children[0];
    if (refY.type !== "composition") throw new Error();
    const yDef = refY.children[0];
    if (yDef.type !== "clip") throw new Error();
    // Y should resolve via compA's refs (where X was authored), not compB's
    expect(yDef.source).toBe("compA-Y.mp4");
  });

  it("throws on unknown ref name", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [{ type: "ref", source: "nope", in: 0, out: 5 }],
    };
    expect(() => inlineRefs(doc)).toThrow(/nope/);
  });

  it("throws on direct cycle", () => {
    const doc: SeamFile = {
      type: "composition",
      refs: {
        R: { type: "ref", source: "R", in: 0, out: 5 },
      },
      children: [{ type: "ref", source: "R", in: 0, out: 5 }],
    };
    expect(() => inlineRefs(doc)).toThrow(/cycle/);
  });

  it("throws on mutual cycle", () => {
    const doc: SeamFile = {
      type: "composition",
      refs: {
        A: { type: "ref", source: "B", in: 0, out: 5 },
        B: { type: "ref", source: "A", in: 0, out: 5 },
      },
      children: [{ type: "ref", source: "A", in: 0, out: 5 }],
    };
    expect(() => inlineRefs(doc)).toThrow(/cycle/);
  });

  it("resolveComposition auto-inlines and produces correct durations", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        { type: "ref", source: "R", in: 0, out: 3 },
        { type: "ref", source: "R", in: 3, out: 5 },
      ],
      refs: {
        R: { type: "clip", source: "c.mp4", in: 0, out: 5 },
      },
    };
    const resolved = resolveComposition(doc);
    // Two sibling refs windowing the same 5s clip: 3s + 2s = 5s total
    expect(resolved.duration).toBeCloseTo(5);
    expect(resolved.children).toHaveLength(2);
  });
});
