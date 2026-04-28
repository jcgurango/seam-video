import { describe, it, expect } from "vitest";
import { validate, parseSeamFile } from "../validate.js";

describe("validate", () => {
  it("accepts a minimal valid composition", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "video.mp4", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts composition with multiple children", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 3 },
        { type: "empty", duration: 1 },
        { type: "clip", source: "b.mp4", in: 2, out: 7 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts nested compositions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "composition",
          children: [
            { type: "clip", source: "inner.mp4", in: 0, out: 3 },
          ],
          in: 0,
          out: 3,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts overflow and underflow", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          overflow: "trim-center",
          underflow: "extend-end",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects flex (no longer a spec concept)", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 5, flex: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unitDuration (no longer a spec concept)", () => {
    const result = validate({
      type: "composition",
      unitDuration: 5,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 10 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects layout (no longer a spec concept)", () => {
    const result = validate({
      type: "composition",
      layout: { justify: "center", gap: 0.5 },
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects refs (no longer a spec concept)", () => {
    const result = validate({
      type: "composition",
      refs: {
        R: { type: "clip", source: "a.mp4", in: 0, out: 5 },
      },
      children: [
        { type: "ref", source: "R", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty children array", () => {
    const result = validate({
      type: "composition",
      children: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing type", () => {
    const result = validate({
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects clip with missing source", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "clip", in: 0, out: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative in value", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: -1, out: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero out value", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts spatial fields on clips", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          position: "absolute",
          left: "10px",
          top: "20%",
          width: "480px",
          height: "270px",
          objectFit: "cover",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts spatial fields on compositions", () => {
    const result = validate({
      type: "composition",
      objectFit: "fit",
      children: [
        {
          type: "composition",
          left: "0px",
          top: "0px",
          width: "50%",
          height: "50%",
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts spatial fields on nested compositions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "composition",
          position: "relative",
          width: "100%",
          height: "100%",
          objectFit: "center",
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid dimension strings", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          width: "10em",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid objectFit value", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          objectFit: "stretch",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts clip with speed", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, speed: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts clip with duration", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, duration: 10 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects clip with both speed and duration", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, speed: 2, duration: 10 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts filters on clips", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          filters: [
            { type: "adjust", brightness: 0.2, contrast: 1.5 },
            { type: "opacity", value: 0.8 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts filters on compositions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "composition",
          filters: [{ type: "colortemperature", temperature: 3500 }],
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts filters on nested compositions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "composition",
          filters: [{ type: "colorbalance", rs: 0.5, bh: -0.3 }],
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty filters array", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, filters: [] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid filter type", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          filters: [{ type: "blur", radius: 5 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range filter values", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          filters: [{ type: "adjust", brightness: 5 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid position value", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          position: "fixed",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an html node with explicit content dims", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "html",
          source: "<b>hi</b>",
          duration: 5,
          contentWidth: 100,
          contentHeight: 100,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an html node without content dims (canvas fallback)", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "html", source: "<b>hi</b>", duration: 3 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an html node with spatial fields and filters", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "html",
          source: "<b>hi</b>",
          duration: 2,
          contentWidth: 200,
          contentHeight: 100,
          top: "10px",
          left: "20%",
          width: "50%",
          objectFit: "cover",
          filters: [{ type: "opacity", value: 0.5 }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an html node missing duration", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "html", source: "<b>hi</b>" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an html node with unknown extra fields", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "html", source: "<b>hi</b>", duration: 1, weird: 7 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseSeamFile", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5 }],
    });
    const result = parseSeamFile(json);
    expect(result.success).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseSeamFile("not json");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContain("Invalid JSON");
    }
  });
});
