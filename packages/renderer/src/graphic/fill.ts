// Fill defaults round-trip for graphic objects. Takes the authored
// JSON shape and uses fabric/node to produce a "filled" snapshot — every
// fabric class default explicitly present, paths/points normalized to
// fabric's canonical array form. The pure interpolation engine in
// @seam/core/animation/interp.ts then consumes these snapshots directly.
//
// Mirrors the env-specific half of motion-editor-test's fillObject, but
// running against the Node build of fabric (which uses node-canvas
// internally for measurements).

import { classRegistry } from "fabric/node";
import { buildFlat, type FilledFrame, type FilledObject, type FilledTree, type FlatFrame } from "@seam/core";

const CUSTOM_PROPS: string[] = [
  "id",
  "revolutions",
  "angleDirection",
  "easing",
  "paths",
  "clipId",
  "startPosition",
  "repeat",
  "pmtilesSrc",
  "latitude",
  "longitude",
  "zoom",
  "source",
  "theme",
  // Image-source related — preserved verbatim through the round-trip.
  "src",
  "crossOrigin",
];

export { CUSTOM_PROPS };

/** Round-trip a single authored object through fabric/node to produce
 *  a snapshot with every default property explicit. Falls back to a
 *  shallow clone when the type isn't registered (forward-compat with
 *  unknown / custom node types). */
export async function fillObject(
  authored: Record<string, unknown>,
): Promise<FilledObject> {
  const type = authored.type;
  if (typeof type !== "string") return { ...authored };
  try {
    const Cls = classRegistry.getClass(type) as unknown as {
      fromObject?: (o: Record<string, unknown>) => Promise<unknown>;
      new (o?: Record<string, unknown>): unknown;
    };
    let inst: {
      includeDefaultValues: boolean;
      toObject(props: string[]): FilledObject;
    };
    if (typeof Cls.fromObject === "function") {
      inst = (await Cls.fromObject({ ...authored })) as typeof inst;
    } else {
      inst = new (Cls as unknown as new (o: Record<string, unknown>) => typeof inst)(
        { ...authored },
      );
    }
    const prev = inst.includeDefaultValues;
    inst.includeDefaultValues = true;
    const filled = inst.toObject(CUSTOM_PROPS);
    inst.includeDefaultValues = prev;
    return filled;
  } catch {
    return { ...authored };
  }
}

/** Fill every authored object in a keyframe's `objects` array. Order
 *  preserved so cross-frame positional matching stays stable. */
export async function fillFrame(
  authored: ReadonlyArray<unknown>,
  frameIndex: number,
): Promise<FilledFrame> {
  const tree: FilledTree = await Promise.all(
    authored.map((o) => fillObject(o as Record<string, unknown>)),
  );
  const flat: FlatFrame = {};
  buildFlat(tree, "", flat);
  return { tree, flat, frameIndex };
}
