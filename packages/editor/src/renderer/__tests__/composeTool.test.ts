import { describe, expect, it } from "vitest";
import { validate, type Child, type Composition } from "@seam/core";
import { applyCompose, walkComposeDependencies } from "../composeTool.js";

const clip = (extra: Record<string, unknown> = {}): Child =>
  ({ type: "clip", source: "a.mp4", in: 0, out: 2, ...extra }) as Child;
const text = (extra: Record<string, unknown> = {}): Child =>
  ({ type: "text", text: "t", duration: 1, ...extra }) as Child;
const comp = (children: Child[]): Composition => ({ type: "composition", children });

function compose(children: Child[], selected: number[]) {
  const r = applyCompose(comp(children), selected);
  if (!r) throw new Error("not composable");
  expect(validate(r.container).success).toBe(true);
  return r;
}

describe("applyCompose", () => {
  it("wraps a slice of one run in place; the wrapper lifts the first node's offset", () => {
    const r = compose(
      [clip({ id: "a" }), clip({ id: "b", offset: 1 }), clip({ id: "c", offset: -0.5 }), clip({ id: "d" })],
      [1, 2],
    );
    expect(r.index).toBe(1);
    expect(r.container.children).toEqual([
      clip({ id: "a" }),
      { type: "composition", id: "b", offset: 1, children: [clip(), clip({ id: "c", offset: -0.5 })] },
      clip({ id: "d" }),
    ]);
  });

  it("a whole run keeps its start on the wrapper", () => {
    const r = compose([clip(), text({ start: 3, offset: 0.5 }), text()], [1, 2]);
    expect(r.container.children).toEqual([
      clip(),
      { type: "composition", start: 3, offset: 0.5, children: [text(), text()] },
    ]);
  });

  it("pulls in runs anchored to a wrapped id, transitively; anchors to the lifted id stay outside", () => {
    const children = [
      clip({ id: "a" }),
      clip({ id: "b" }),
      clip({ id: "c" }),
      text({ id: "onA", start: "a@1" }),
      text({ id: "onB", start: "b@50%" }),
      text(), // member of onB's run
      text({ start: "onB", offset: 0.2 }),
    ];
    expect(walkComposeDependencies(children, [0, 1])).toEqual([0, 1, 4, 5, 6]);
    const r = compose(children, [0, 1]);
    expect(r.container.children).toEqual([
      {
        type: "composition",
        id: "a",
        children: [
          clip(),
          clip({ id: "b" }),
          text({ id: "onB", start: "b@50%" }),
          text(),
          text({ start: "onB", offset: 0.2 }),
        ],
      },
      clip({ id: "c" }),
      text({ id: "onA", start: "a@1" }),
    ]);
  });

  it("a scattered selection becomes one run at the first node's slot", () => {
    const r = compose(
      [clip({ id: "a" }), clip({ id: "b" }), text({ id: "t", start: 4 }), text({ id: "u" }), text({ start: 9 })],
      [0, 2],
    );
    expect(r.index).toBe(0);
    expect(r.container.children).toEqual([
      { type: "composition", id: "a", children: [clip(), text({ id: "t" })] },
      clip({ id: "b" }),
      // The removed head hands its placement to the run's survivor.
      text({ id: "u", start: 4 }),
      text({ start: 9 }),
    ]);
  });

  it("a selected node anchored to another wrapped node keeps its anchor", () => {
    const r = compose([clip({ id: "a" }), clip({ id: "b" }), text({ start: "b@1" })], [0, 1, 2]);
    expect(r.container.children).toEqual([
      { type: "composition", id: "a", children: [clip(), clip({ id: "b" }), text({ start: "b@1" })] },
    ]);
  });

  it("pins the lifted node at 0 when a pulled-in run sits below it", () => {
    const r = compose([text({ start: "b" }), clip({ id: "a", start: 2 }), clip({ id: "b" })], [1, 2]);
    expect(r.index).toBe(0);
    expect(r.container.children).toEqual([
      {
        type: "composition",
        id: "a",
        start: 2,
        children: [text({ start: "b" }), clip({ start: 0 }), clip({ id: "b" })],
      },
    ]);
  });

  it("returns null for an empty / out-of-range selection", () => {
    expect(applyCompose(comp([clip()]), [])).toBeNull();
    expect(applyCompose(comp([clip()]), [3])).toBeNull();
  });
});
