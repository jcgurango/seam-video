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

  it("accepts empty children array", () => {
    // children was relaxed when bin/script became first-party — a
    // scripted composition can legitimately have no children, and a
    // bin reference takes its body from the bin entry. The resolver
    // handles a zero-duration empty composition fine.
    const result = validate({
      type: "composition",
      children: [],
    });
    expect(result.success).toBe(true);
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
          translation: { x: 10, y: "20%" },
          size: { x: 480, y: 270 },
          origin: "0%",
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
          translation: "0%",
          origin: "0%",
          size: "50%",
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
          size: "100%",
          objectFit: "center",
          children: [
            { type: "clip", source: "v.mp4", in: 0, out: 5 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid length strings", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          size: "10em",
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

  it("accepts composition with speed", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "composition", speed: 2, children: [
          { type: "clip", source: "v.mp4", in: 0, out: 5 },
        ] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts composition with explicit duration", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "composition", duration: 10, children: [
          { type: "clip", source: "v.mp4", in: 0, out: 5 },
        ] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects composition with both speed and duration", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "composition", speed: 2, duration: 10, children: [
          { type: "clip", source: "v.mp4", in: 0, out: 5 },
        ] },
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
          opacity: 0.8,
          filters: [{ type: "adjust", brightness: 0.2, contrast: 1.5 }],
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

  it("accepts inset on a composition (shorthand forms)", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "composition", inset: 100, children: [] },
        { type: "composition", inset: [50, "10%"], children: [] },
        { type: "composition", inset: ["5%", 10, "5%", 10], children: [] },
        {
          type: "composition",
          inset: [[0, 0], [1, 100, "ease-in"]],
          children: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects inset on a clip (composition-only)", () => {
    const result = validate({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, inset: 100 },
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

  it("rejects unknown spatial field (no position any more)", () => {
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

  it("accepts keyframed volume on a clip", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip", source: "v.mp4", in: 0, out: 5,
          volume: [[0, 0], ["50%", 1, "ease-in"], ["100%", 0]],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts keyframed spatial dimensions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip", source: "v.mp4", in: 0, out: 5,
          translation: [[0, { x: 0, y: 0 }], [2, { x: 100, y: 0 }]],
          size: [[0, "50%"], ["100%", "75%"]],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts keyframed text style fields", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "text",
          text: "hi",
          duration: 2,
          fontSize: [[0, 24], ["100%", 64]],
          color: [[0, "red"], [1, "blue", "ease-in-out"]],
          backgroundPadding: [[0, 5], [1, [10, 20]]],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts keyframed opacity", () => {
    const result = validate({
      type: "composition",
      opacity: [[0, 0], [1, 1, "ease-in"]],
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects keyframed filter params (filters are static)", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip",
          source: "v.mp4",
          in: 0,
          out: 5,
          filters: [{ type: "adjust", brightness: [[0, 0], [1, 1]] }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed keyframe time expressions", () => {
    const result = validate({
      type: "composition",
      children: [
        {
          type: "clip", source: "v.mp4", in: 0, out: 5,
          volume: [["bad-time", 0]],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects keyframe values outside the static field's range", () => {
    const result = validate({
      type: "composition",
      opacity: [[0, 0], [1, 5]], // 5 > max(1)
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("validate — verbose error messages", () => {
  // Helper: pull the error list off a result we expect to have failed.
  const errs = (input: unknown): string[] => {
    const result = validate(input);
    expect(result.success).toBe(false);
    return result.success ? [] : result.errors;
  };

  it("never collapses a malformed child to a bare 'Invalid input'", () => {
    // Regression: ChildSchema is a z.union, so Zod's top-level union message
    // ("Invalid input") used to be all the user saw.
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 0 }],
    });
    expect(messages.join("\n")).not.toMatch(/Invalid input/);
  });

  it("reports the offending field and its location inside a child", () => {
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 0 }],
    });
    // out must be positive — points at children[0].out, not the union root.
    expect(messages.some((m) => /children\[0\]\.out/.test(m))).toBe(true);
  });

  it("does not spam sibling-branch type complaints for a known type", () => {
    // A clip with a real problem should not also surface "expected literal
    // 'audio'/'static'/…" noise from the other union branches.
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 0 }],
    });
    expect(messages.some((m) => /audio|static|empty|graphic/.test(m))).toBe(
      false
    );
  });

  it("lists the valid node types when 'type' is unrecognized", () => {
    const messages = errs({
      type: "composition",
      children: [{ type: "klip", source: "v.mp4", in: 0, out: 5 }],
    });
    const joined = messages.join("\n");
    expect(joined).toMatch(/children\[0\]\.type/);
    expect(joined).toMatch(/clip/);
    expect(joined).toMatch(/audio/);
  });

  it("names the missing field for a child with no source", () => {
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", in: 0, out: 5 }],
    });
    expect(messages.some((m) => /children\[0\]\.source/.test(m))).toBe(true);
  });

  it("surfaces the regex guidance for a bad length string", () => {
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5, size: "10em" }],
    });
    const joined = messages.join("\n");
    expect(joined).toMatch(/children\[0\]\.size/);
    expect(joined).toMatch(/%/); // the "Must be a number, '<n>%', …" guidance
  });

  it("surfaces a node's refine() message verbatim", () => {
    const messages = errs({
      type: "composition",
      children: [
        { type: "clip", source: "v.mp4", in: 0, out: 5, speed: 2, duration: 10 },
      ],
    });
    expect(
      messages.some((m) => /both 'speed' and 'duration'/.test(m))
    ).toBe(true);
  });

  it("reports unrecognized keys with the key name", () => {
    const messages = errs({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: 5, flex: 1 }],
    });
    expect(messages.some((m) => /flex/.test(m))).toBe(true);
  });

  it("locates a problem nested inside a child composition", () => {
    const messages = errs({
      type: "composition",
      children: [
        {
          type: "composition",
          children: [{ type: "clip", source: "v.mp4", in: 0, out: 0 }],
        },
      ],
    });
    expect(
      messages.some((m) => /children\[0\]\.children\[0\]\.out/.test(m))
    ).toBe(true);
  });

  it("reports a real problem inside a graphic object union", () => {
    const messages = errs({
      type: "composition",
      children: [
        {
          type: "graphic",
          duration: 2,
          frames: [[0, [{ type: "Circle", radius: -5 }]]],
        },
      ],
    });
    const joined = messages.join("\n");
    expect(joined).not.toMatch(/Invalid input/);
    expect(joined).toMatch(/radius/);
  });
});

describe("validate — macro expansion runs before schema checks", () => {
  it("accepts an array-valued macro spliced into a typed array", () => {
    // Regression: validation used to run on the raw source, so the
    // "$$POINTS" placeholder failed MapPath.points (needs >=2 [num,num]
    // tuples) even though the expanded document is valid.
    const result = validate({
      type: "composition",
      macros: {
        POINTS: [
          [133.19, 34.4],
          [133.2, 34.41],
        ],
      },
      children: [
        {
          type: "graphic",
          duration: 5,
          frames: [
            [
              0,
              [
                {
                  type: "Map",
                  source: "area.pmtiles",
                  paths: [{ color: "red", points: ["$$POINTS"] }],
                },
              ],
            ],
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("preserves the authored source (macros + $$ refs) on success", () => {
    const doc = {
      type: "composition",
      macros: { FG: "white" },
      children: [{ type: "text", text: "$$FG", duration: 2, color: "$$FG" }],
    };
    const result = validate(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      // The editor keeps this as canonical state — it must still contain the
      // macro block and unexpanded references, not the expanded form.
      expect(result.data).toEqual(doc);
    }
  });

  it("still reports schema errors against the expanded document", () => {
    const result = validate({
      type: "composition",
      macros: { BAD: -5 },
      children: [{ type: "clip", source: "v.mp4", in: 0, out: "$$BAD" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => /children\[0\]\.out/.test(e))).toBe(true);
    }
  });

  it("surfaces macro errors (e.g. undefined refs) as validation failures", () => {
    const result = validate({
      type: "composition",
      children: [{ type: "clip", source: "v.mp4", in: 0, out: "$$NOPE" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => /undefined macro \$\$NOPE/.test(e))).toBe(
        true
      );
    }
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
