import { describe, expect, it } from "vitest";
import type { Child, SeamFile } from "@seam/core";
import { removeSelected } from "../selection.js";

const clip = (fields: Record<string, unknown>): Child =>
  ({ type: "clip", source: "a.mp4", in: 0, out: 5, ...fields }) as unknown as Child;

describe("removeSelected", () => {
  it("a removed run head hands its start/offset to its successor", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [clip({}), clip({ start: 3, offset: 1 }), clip({ source: "b.mp4" })],
    };
    expect(removeSelected(doc, [1]).children).toEqual([
      clip({}),
      clip({ source: "b.mp4", start: 3, offset: 1 }),
    ]);
  });

  it("cascades to runs anchored to a removed node's id", () => {
    const doc: SeamFile = {
      type: "composition",
      children: [
        clip({ id: "A" }),
        clip({ source: "b.mp4" }),
        clip({ source: "over.mp4", start: "A@2" }),
        clip({ source: "over2.mp4" }),
      ],
    };
    expect(removeSelected(doc, [0]).children).toEqual([clip({ source: "b.mp4" })]);
  });
});
