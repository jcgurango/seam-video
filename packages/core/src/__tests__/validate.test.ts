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

  it("accepts layout options", () => {
    const result = validate({
      type: "composition",
      duration: 30,
      layout: { justify: "center", gap: 0.5 },
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts flex on children", () => {
    const result = validate({
      type: "composition",
      duration: 20,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 5, flex: 1 },
        { type: "clip", source: "b.mp4", in: 0, out: 5, flex: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts overflow and underflow", () => {
    const result = validate({
      type: "composition",
      duration: 10,
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          flex: 1,
          overflow: "trim-center",
          underflow: "extend-end",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts unitDuration", () => {
    const result = validate({
      type: "composition",
      unitDuration: 5,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 10 },
        { type: "clip", source: "b.mp4", in: 0, out: 10 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects both duration and unitDuration", () => {
    const result = validate({
      type: "composition",
      duration: 20,
      unitDuration: 5,
      children: [
        { type: "clip", source: "a.mp4", in: 0, out: 10 },
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

  it("rejects invalid justify value", () => {
    const result = validate({
      type: "composition",
      layout: { justify: "invalid" },
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative gap", () => {
    const result = validate({
      type: "composition",
      layout: { gap: -1 },
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5 }],
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

  it("accepts spatial fields on overlays", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "overlay",
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
