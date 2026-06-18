// Browser fabric round-trip — same shape as the renderer's fillObject,
// but pulls in fabric's browser build so we don't drag in node-canvas.
// Used by GraphicStore to fill defaults before interpolation.

import { classRegistry } from "fabric";
import type {
  FilledObject,
  FilledTree,
  FilledFrame,
  FlatFrame,
} from "@seam/core";
import { buildFlat } from "@seam/core";

export const CUSTOM_PROPS = [
  "id",
  "clipId",
  "startPosition",
  "repeat",
  "source",
  "latitude",
  "longitude",
  "zoom",
  "paths",
  "theme",
  "revolutions",
  "angleDirection",
] as const;

export async function fillObject(
  authored: Record<string, unknown>,
): Promise<FilledObject> {
  const type = authored.type;
  if (typeof type !== "string") return { ...authored };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Cls = classRegistry.getClass(type) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inst: any;
    if (typeof Cls.fromObject === "function") {
      inst = await Cls.fromObject({ ...authored });
    } else {
      inst = new Cls({ ...authored });
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

async function fillTree(tree: ReadonlyArray<unknown>): Promise<FilledTree> {
  const out: FilledTree = [];
  for (const node of tree) {
    const filled = await fillObject(node as Record<string, unknown>);
    if (
      filled.type === "Group" &&
      Array.isArray((filled as Record<string, unknown>).objects)
    ) {
      (filled as Record<string, unknown>).objects = await fillTree(
        (filled as Record<string, unknown>).objects as unknown[],
      );
    }
    out.push(filled);
  }
  return out;
}

export async function fillFrame(
  tree: ReadonlyArray<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _frameIdx: number,
): Promise<FilledFrame> {
  const filled = await fillTree(tree);
  // buildFlat is void — populates the FlatFrame passed in as the third
  // arg by walking `tree`. Returning its result (undefined) is the bug
  // that made the next-tier loop set keys on `undefined`.
  const flat: FlatFrame = {};
  buildFlat(filled, "", flat);
  return { tree: filled, flat };
}
