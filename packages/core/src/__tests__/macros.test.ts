import { describe, it, expect } from "vitest";
import { expandMacros, findUnresolvedMacros } from "../macros.js";
import { parseSeamFile } from "../validate.js";
import { compileSeamFile } from "../compile.js";

describe("macro expansion", () => {
  it("substitutes scalar values at object value positions", () => {
    const result = expandMacros({
      type: "composition",
      macros: { COLOR_BUS: "red" },
      backgroundColor: "$$COLOR_BUS",
      children: [],
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: "composition",
      backgroundColor: "red",
      children: [],
    });
  });

  it("substitutes object-valued macros as single array elements", () => {
    const fade = {
      type: "opacity",
      value: [[0, 0], [0.25, 1]],
    };
    const result = expandMacros({
      type: "composition",
      macros: { FADE: fade },
      children: [
        { type: "clip", source: "x", in: 0, out: 5, filters: ["$$FADE"] },
      ],
    });
    expect(result.success).toBe(true);
    expect((result.data as { children: unknown[] }).children).toEqual([
      { type: "clip", source: "x", in: 0, out: 5, filters: [fade] },
    ]);
  });

  it("splices array-valued macros inside arrays", () => {
    const points = [[34.24, 132.5], [34.25, 132.6]];
    const result = expandMacros({
      type: "composition",
      macros: { POINTS: points },
      children: [
        {
          type: "graphic",
          frames: [
            [
              0,
              [
                {
                  type: "Map",
                  paths: [
                    { color: "red", points: ["$$POINTS"] },
                    {
                      color: "blue",
                      points: [
                        [0, 0],
                        "$$POINTS",
                        [99, 99],
                      ],
                    },
                  ],
                },
              ],
            ],
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      children: Array<{
        frames: Array<[number, Array<{ paths: Array<{ points: unknown[] }> }>]>;
      }>;
    };
    const paths = data.children[0].frames[0][1][0].paths;
    expect(paths[0].points).toEqual(points);
    expect(paths[1].points).toEqual([[0, 0], ...points, [99, 99]]);
  });

  it("errors when an array macro is used outside an array", () => {
    const result = expandMacros({
      type: "composition",
      macros: { POINTS: [[0, 0], [1, 1]] },
      children: [{ type: "graphic", paths: "$$POINTS" }],
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toMatch(/array macros must be used inside an array/);
  });

  it("errors on undefined macro refs", () => {
    const result = expandMacros({
      type: "composition",
      backgroundColor: "$$NOPE",
      children: [],
    });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/undefined macro \$\$NOPE/);
  });

  it("walks up the composition tree to find the nearest macros block", () => {
    const result = expandMacros({
      type: "composition",
      macros: { FG: "white" },
      children: [
        {
          type: "composition",
          // Inner composition has no macros block — FG resolves to the
          // outer composition.
          backgroundColor: "$$FG",
          children: [],
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(
      (result.data as { children: Array<{ backgroundColor: string }> })
        .children[0].backgroundColor,
    ).toBe("white");
  });

  it("inner composition's macros shadow the outer's", () => {
    const result = expandMacros({
      type: "composition",
      macros: { COLOR: "red" },
      children: [
        {
          type: "composition",
          macros: { COLOR: "blue" },
          backgroundColor: "$$COLOR",
          children: [],
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(
      (result.data as { children: Array<{ backgroundColor: string }> })
        .children[0].backgroundColor,
    ).toBe("blue");
  });

  it("resolves sibling references within the same macros block", () => {
    // Mirrors the user-reported case: MAP holds a Map-element-shaped
    // object whose `paths[0].points` is `["$$POINTS"]`, and POINTS
    // sits beside it in the same block.
    const points = [
      [34.41, 133.20],
      [34.38, 132.45],
    ];
    const result = expandMacros({
      type: "composition",
      macros: {
        MAP: {
          type: "Map",
          id: "map",
          source: "area.pmtiles",
          paths: [{ color: "blue", points: ["$$POINTS"] }],
        },
        POINTS: points,
      },
      children: [
        {
          type: "graphic",
          frames: [[0, ["$$MAP"]]],
        },
      ],
    });
    expect(result.success).toBe(true);
    const graphic = (result.data as { children: Array<{ frames: Array<[number, unknown[]]> }> })
      .children[0];
    const mapObj = graphic.frames[0][1][0] as {
      type: string;
      paths: Array<{ points: unknown[] }>;
    };
    expect(mapObj.type).toBe("Map");
    expect(mapObj.paths[0].points).toEqual(points);
  });

  it("detects cyclic macro references", () => {
    const result = expandMacros({
      type: "composition",
      macros: {
        A: { value: "$$B" },
        B: { value: "$$A" },
      },
      backgroundColor: "$$A",
      children: [],
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cycle/);
  });

  it("strips the macros field from the expanded output", () => {
    const result = expandMacros({
      type: "composition",
      macros: { X: 42 },
      children: [],
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("macros");
  });

  it("a bin item with a macro ref resolves in the composition where the bin is DEFINED", () => {
    const result = expandMacros({
      type: "composition",
      macros: { OUTER_COLOR: "navy" },
      bin: [
        {
          id: "ref",
          children: [
            { type: "static", source: "img.png", backgroundColor: "$$OUTER_COLOR" },
          ],
        },
      ],
      children: [
        {
          type: "composition",
          // This composition USES the bin entry. Even though the
          // bin's body lands here at compile time, its macros are
          // resolved at expansion time against the DEFINING scope
          // (outer composition).
          binItem: "ref",
        },
      ],
    });
    expect(result.success).toBe(true);
    const bin = (result.data as { bin: Array<{ children: Array<{ backgroundColor: string }> }> }).bin;
    expect(bin[0].children[0].backgroundColor).toBe("navy");
  });

  it("ignores non-object macros fields without crashing", () => {
    const result = expandMacros({
      type: "composition",
      macros: "not an object",
      children: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("findUnresolvedMacros", () => {
  it("returns null on a clean tree", () => {
    expect(findUnresolvedMacros({ a: 1, b: "x", c: [1, 2, 3] })).toBeNull();
  });

  it("locates a stray $$NAME at a deep path", () => {
    const found = findUnresolvedMacros({
      a: { b: [{ c: "$$NOPE" }] },
    });
    expect(found).toEqual({ path: "a.b[0].c", name: "NOPE" });
  });
});

describe("parseSeamFile + macros", () => {
  it("validates a source doc with macros without expanding (round-trip preserved)", () => {
    const json = JSON.stringify({
      type: "composition",
      macros: { COLOR: "red" },
      backgroundColor: "$$COLOR",
      children: [],
    });
    const result = parseSeamFile(json);
    expect(result.success).toBe(true);
    if (result.success) {
      // Macros field preserved; the "$$COLOR" reference is still a
      // string. Editor JSON view sees what the user authored.
      expect(result.data).toEqual({
        type: "composition",
        macros: { COLOR: "red" },
        backgroundColor: "$$COLOR",
        children: [],
      });
    }
  });
});

describe("compile + macros", () => {
  it("expands macros as the first compile step", () => {
    const result = compileSeamFile({
      type: "composition",
      macros: { COLOR: "red" },
      backgroundColor: "$$COLOR",
      children: [],
    });
    expect(result.errors).toEqual([]);
    expect((result.doc as { backgroundColor: string }).backgroundColor).toBe("red");
    expect(result.doc).not.toHaveProperty("macros");
  });

  it("emits a macro CompileError for unresolved refs", () => {
    const result = compileSeamFile({
      type: "composition",
      backgroundColor: "$$NOPE",
      children: [],
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].source).toBe("macro");
    expect(result.errors[0].message).toMatch(/undefined macro \$\$NOPE/);
  });

  it("flags scripts that emit $$… strings", () => {
    const result = compileSeamFile({
      type: "composition",
      children: [],
      script: 'return { type: "composition", children: [], backgroundColor: "$$NOPE" };',
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].source).toBe("script");
    expect(result.errors[0].message).toMatch(/unresolved macro \$\$NOPE/);
  });
});
