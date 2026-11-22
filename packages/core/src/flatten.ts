import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedAudio,
  ResolvedStatic,
  ResolvedData,
  ResolvedText,
  ResolvedRect,
  ResolvedCircle,
  ResolvedExtensionChild,
} from "./resolved-types.js";
import { asExtensionNode } from "./resolved-types.js";
import { unrollLoops } from "./layout/resolve.js";

export type FlatLeaf =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedData
  | ResolvedText
  | ResolvedRect
  | ResolvedCircle
  | ResolvedExtensionChild;

/**
 * Flatten a resolved tree into a linear list of leaves (clips, audios,
 * data, …). Compounds speed and offsets through nested compositions.
 * Looping nodes are unrolled into the cycles they play (see `unrollLoops`),
 * so every leaf here is a plain span.
 */
export function flattenResolved(
  children: ResolvedChild[],
  parentOffset = 0,
  parentSpeed = 1
): FlatLeaf[] {
  const result: FlatLeaf[] = [];

  for (const child of unrollLoops(children)) {
    const start = parentOffset + child.timelineStart / parentSpeed;
    const end = parentOffset + child.timelineEnd / parentSpeed;

    if (child.type === "clip") {
      result.push({
        type: "clip",
        source: child.source,
        sourceIn: child.sourceIn,
        sourceOut: child.sourceOut,
        timelineStart: start,
        timelineEnd: end,
        speed: child.speed * parentSpeed,
        ...(child.reverse ? { reverse: child.reverse } : {}),
        ...(child.volume != null ? { volume: child.volume } : {}),
      });
    } else if (child.type === "audio") {
      result.push({
        type: "audio",
        source: child.source,
        sourceIn: child.sourceIn,
        sourceOut: child.sourceOut,
        timelineStart: start,
        timelineEnd: end,
        speed: child.speed * parentSpeed,
        ...(child.reverse ? { reverse: child.reverse } : {}),
        ...(child.volume != null ? { volume: child.volume } : {}),
      });
    } else if (child.type === "static") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (child.type === "data") {
      result.push({
        type: "data",
        data: child.data,
        timelineStart: start,
        timelineEnd: end,
        ...(child.tags?.length ? { tags: child.tags } : {}),
      });
    } else if (child.type === "text") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (child.type === "rect" || child.type === "circle") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (asExtensionNode(child)) {
      // An extension node is itself a leaf; a container's children live in
      // node-local time at speed 1, so they flatten like a composition's
      // children offset by the node's start.
      const node = asExtensionNode(child)!;
      result.push({ ...node, timelineStart: start, timelineEnd: end } as unknown as FlatLeaf);
      if (node.children) {
        result.push(...flattenResolved(node.children, start, parentSpeed));
      }
    } else if (child.type === "composition") {
      // Composition: recurse with compounded speed and offset
      const compoundSpeed = child.speed * parentSpeed;
      const innerFlat = flattenResolved(child.children, start, compoundSpeed);
      result.push(...innerFlat);
    }
  }

  return result;
}
