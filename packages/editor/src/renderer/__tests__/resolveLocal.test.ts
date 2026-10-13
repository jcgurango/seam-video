import { describe, expect, it } from "vitest";
import { resolveComposition, type SeamFile } from "@seam/core";
import { descendToContainer } from "../resolveLocal.js";

// The playhead→inner-time descent must wrap into the current cycle of a
// looping composition (`underflow: "loop"`), so slice/attach inside one land
// on the content actually showing under the playhead.

describe("descendToContainer — looping composition", () => {
  const doc: SeamFile = {
    type: "composition",
    children: [{ id: "bed", type: "empty", duration: 10 }],
    attachments: [
      {
        type: "composition",
        underflow: "loop",
        in: 0.5,
        children: [{ type: "clip", source: "v.mp4", in: 0, out: 2.5 }],
        start: { anchor: "bed", timeSource: "output", anchorPoint: "0%" },
        end: { anchor: "bed", timeSource: "output", anchorPoint: "100%" },
      },
    ],
  };
  const resolved = resolveComposition(doc);
  const path = [{ field: "attachments" as const, index: 0 }];

  it("maps a global time in a later cycle back into the 2s inner window", () => {
    // Window is [0.5, 2.5] → 2s period. Global 5.3s = cycle 2 + 1.3s →
    // inner 0.5 + 1.3 = 1.8.
    const d = descendToContainer(resolved, doc, path, 5.3);
    expect(d).not.toBeNull();
    expect(d!.localTime).toBeCloseTo(1.8);
  });

  it("first cycle is the plain mapping", () => {
    const d = descendToContainer(resolved, doc, path, 0.7);
    expect(d!.localTime).toBeCloseTo(1.2);
  });
});
