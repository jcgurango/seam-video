import { describe, it, expect } from "vitest";
import { createSeam, resolveSpatial, type Composition } from "@seam/core";
import { normalizeTextRuns, plainText, text, textNode } from "../index.js";

const seam = createSeam([text]);
const doc = (...children: unknown[]) => ({ type: "composition", children });
const valid = (...children: unknown[]) => {
  const r = seam.validate(doc(...children));
  return r.success ? true : r.errors.join("\n");
};

describe("text node — schema", () => {
  it("accepts a string, and strings mixed with styled runs", () => {
    expect(valid({ type: "text", text: "hi", duration: 2 })).toBe(true);
    expect(
      valid({ type: "text", duration: 2, text: ["plain ", { text: "bold", fontWeight: "bold", color: "red" }] }),
    ).toBe(true);
  });

  it("accepts keyframed style fields", () => {
    expect(
      valid({
        type: "text",
        text: "hi",
        duration: 2,
        fontSize: [[0, 24], ["100%", 64]],
        color: [[0, "red"], [1, "blue", "ease-in-out"]],
        backgroundPadding: [[0, 5], [1, [10, 20]]],
        strokeWidth: [[0, 0], [1, 8]],
        lineHeight: 30,
      }),
    ).toBe(true);
  });

  it("accepts every style and layout field, plus the common node fields", () => {
    expect(
      valid({
        type: "text",
        id: "t",
        start: 1,
        text: "hi",
        duration: 2,
        fontFamily: "Liberation Sans",
        fontWeight: "700",
        fontStyle: "italic",
        textDecoration: "underline",
        letterHeight: "120%",
        backgroundColor: "black",
        strokeColor: "white",
        textAlign: "left",
        verticalAlign: "bottom",
        padding: [10, 20, 30, 40],
        contentWidth: "50%",
        contentHeight: 300,
        size: "80%",
        rotation: 12,
        opacity: 0.5,
        cornerRadius: 8,
      }),
    ).toBe(true);
  });

  it("rejects what the old core schema rejected", () => {
    expect(valid({ type: "text", duration: 2 })).not.toBe(true); // no text
    expect(valid({ type: "text", text: "hi" })).not.toBe(true); // no duration
    expect(valid({ type: "text", text: "hi", duration: 2, fontSize: 0 })).not.toBe(true);
    expect(valid({ type: "text", text: "hi", duration: 2, letterHeight: "tall" })).not.toBe(true);
    expect(valid({ type: "text", text: "hi", duration: 2, padding: [1, 2, 3] })).not.toBe(true);
    expect(valid({ type: "text", text: "hi", duration: 2, textAlign: "justify" })).not.toBe(true);
    expect(valid({ type: "text", text: [{ text: "x", nope: 1 }], duration: 2 })).not.toBe(true);
    expect(valid({ type: "text", text: "hi", duration: 2, nope: 1 })).not.toBe(true);
  });

  it("is unknown without the extension", () => {
    expect(createSeam().validate(doc({ type: "text", text: "hi", duration: 2 })).success).toBe(false);
  });
});

describe("text node — resolve", () => {
  it("is placed like any node and carries its own fields verbatim", () => {
    const t = resolveSpatial(
      seam.resolveComposition(
        doc({ type: "rect", duration: 3 }, { type: "text", text: ["a", { text: "b" }], duration: 2, fontSize: 40, offset: -1 }) as unknown as Composition,
      ),
      1080,
      1920,
    );
    expect(t.children[1]).toMatchObject({
      type: "text",
      extension: true,
      timelineStart: 2,
      timelineEnd: 4,
      transition: 1,
      text: ["a", { text: "b" }],
      fontSize: 40,
      intrinsicWidth: 1080,
      intrinsicHeight: 1920,
    });
  });
});

describe("helpers", () => {
  it("normalizes and flattens text", () => {
    expect(normalizeTextRuns("hi")).toEqual([{ text: "hi" }]);
    expect(normalizeTextRuns(["a", { text: "b", color: "red" }])).toEqual([{ text: "a" }, { text: "b", color: "red" }]);
    expect(plainText(["a", { text: "b" }])).toBe("ab");
  });

  it("labels its timeline block and offers a New tile", () => {
    expect(textNode.editor!.blockLabel!({ text: "  hello\n world " })).toBe("hello world");
    expect(textNode.editor!.blockLabel!({ text: "x".repeat(40) })).toBe(`${"x".repeat(24)}…`);
    expect(valid(textNode.editor!.palette!.create())).toBe(true);
  });
});

describe("wrap: false — a text node as big as what it says", () => {
  const node = { type: "text", text: "one line", duration: 2, wrap: false };

  it("validates, and refuses an inner canvas of its own", () => {
    expect(valid(node)).toBe(true);
    expect(valid({ ...node, size: "50%", padding: 20 })).toBe(true);
    expect(valid({ ...node, contentWidth: 400 })).toMatch(/sized by its text/);
    expect(valid({ ...node, contentHeight: "50%" })).toMatch(/sized by its text/);
    // Wrapping text keeps its inner canvas.
    expect(valid({ ...node, wrap: true, contentWidth: 400 })).toBe(true);
    expect(valid({ ...node, wrap: "no" })).not.toBe(true);
  });

  it("is flagged measured, keeps its spatial input, and takes the host's measurement as its inner canvas", () => {
    // `objectFit` is what a container gives its children: "center" on the
    // parent keeps the text at its true pixel size.
    const temporal = seam.resolveComposition({
      ...doc({ ...node, origin: "0%", translation: "0%" }, { type: "text", text: "wraps", duration: 2 }),
      objectFit: "center",
    } as unknown as Composition);
    expect(temporal.children[0]).toMatchObject({ type: "text", measured: true });
    expect((temporal.children[1] as { measured?: true }).measured).toBeUndefined();

    // A host that can measure: the resolved rect is the text's real box.
    const measured = resolveSpatial(temporal, 1080, 1920, { measure: () => ({ width: 300, height: 60 }) });
    expect(measured.children[0]).toMatchObject({
      intrinsicWidth: 300,
      intrinsicHeight: 60,
      spatial: { x: 0, y: 0, width: 300, height: 60 },
    });
    // Still laid out per frame by hosts (an animated style changes its size).
    expect((measured.children[0] as { spatialInput?: unknown }).spatialInput).toBeDefined();

    // The default objectFit fits that box into the parent, like an image.
    const fitted = resolveSpatial(
      seam.resolveComposition(doc(node) as unknown as Composition),
      1080,
      1920,
      { measure: () => ({ width: 300, height: 60 }) },
    );
    expect(fitted.children[0]).toMatchObject({ naturalWidth: 1080, naturalHeight: 216 });
  });
});
