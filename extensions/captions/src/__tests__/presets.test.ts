import { describe, it, expect } from "vitest";
import { createSeam } from "@seam/core";
import {
  captions,
  cueStyle,
  DEFAULT_CAPTION_STYLE,
  parseBox,
  presetNameOf,
  presetState,
  readPresets,
  sameStyle,
  withStyle,
} from "../index.js";

const seam = createSeam([captions]);

describe("default caption style", () => {
  it("is what an unstyled surface shows, overridden key by key", () => {
    expect(cueStyle({}, {})).toEqual(DEFAULT_CAPTION_STYLE);
    expect(cueStyle({ fontSize: 80, speakers: { a: { color: "pink" } } }, { speaker: "a", style: { padding: 0 } })).toEqual({
      ...DEFAULT_CAPTION_STYLE,
      fontSize: 80,
      color: "pink",
      padding: 0,
    });
  });
});

describe("presets", () => {
  const presets = readPresets({ news: { fontSize: 60, speakers: { a: { color: "pink" } } }, junk: 3 });

  it("reads only well-formed entries", () => {
    expect(Object.keys(presets)).toEqual(["news"]);
    expect(readPresets(null)).toEqual({});
  });

  it("compares styles ignoring key order and unset keys", () => {
    expect(sameStyle({ fontSize: 60, color: undefined }, { fontSize: 60 })).toBe(true);
    expect(sameStyle({ speakers: { a: { color: "pink" } }, fontSize: 60 }, presets.news)).toBe(true);
    expect(sameStyle({ fontSize: 61 }, { fontSize: 60 })).toBe(false);
    expect(sameStyle(undefined, {})).toBe(true);
  });

  it("says how a composition stands against the preset it names", () => {
    expect(presetState(presets, undefined, {})).toBe("none");
    expect(presetState(presets, "news", presets.news)).toBe("clean");
    expect(presetState(presets, "news", { ...presets.news, color: "red" })).toBe("modified");
    expect(presetState(presets, "gone", {})).toBe("missing");
  });

  it("writes the style and the preset name onto a composition, and removes them cleanly", () => {
    const root = { type: "composition", children: [], metadata: { other: 1 } };
    const styled = withStyle(root, { fontSize: 60, color: undefined, speakers: {} }, "news");
    expect(styled).toEqual({
      type: "composition",
      children: [],
      captionStyle: { fontSize: 60 },
      metadata: { other: 1, captionPreset: "news" },
    });
    expect(presetNameOf(styled)).toBe("news");
    expect(seam.validate(styled).success).toBe(true);
    // An empty style stays ("defined, nothing overridden"); `undefined` removes it.
    expect(withStyle(styled, {}, "news")).toMatchObject({ captionStyle: {} });
    expect(withStyle({ ...styled, metadata: { captionPreset: "news" } }, undefined, undefined)).toEqual({
      type: "composition",
      children: [],
    });
  });

  it("parses the padding shorthand", () => {
    expect(parseBox("200")).toBe(200);
    expect(parseBox("610, 100")).toEqual([610, 100]);
    expect(parseBox("1 2 3 4")).toEqual([1, 2, 3, 4]);
    expect(parseBox("")).toBeUndefined();
    expect(parseBox("1, 2, 3")).toBeNull();
    expect(parseBox("abc")).toBeNull();
  });
});
