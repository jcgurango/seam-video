import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedAudio,
  ResolvedStatic,
  ResolvedData,
  ResolvedRect,
  ResolvedCircle,
  ResolvedExtensionChild,
} from "./resolved-types.js";
import { asExtensionNode } from "./resolved-types.js";
import { unrollLoops } from "./layout/resolve.js";

/** Where a node sits in the time of the tree being walked. */
export interface WalkedSpan {
  /** The node's span in the walk root's time. */
  start: number;
  end: number;
  /** Local seconds per root second at this node's level (enclosing
   *  composition speeds multiplied). */
  rate: number;
}

/**
 * Walk a resolved tree — through compositions (their speed, and their loops
 * unrolled into the cycles they play) and extension containers — calling
 * `visit` for every node with its span in the time of `children`'s own
 * timeline. Return `false` from `visit` to skip a node's subtree.
 *
 * The generic "collected channel": an extension whose nodes are gathered up
 * the tree instead of drawn where they sit (captions) walks with this, the
 * same time mapping `flattenResolved` and the audio mixers use.
 */
export function walkResolved(
  children: ResolvedChild[],
  visit: (node: ResolvedChild, at: WalkedSpan) => boolean | void,
  offset = 0,
  rate = 1,
): void {
  for (const child of unrollLoops(children)) {
    const start = offset + child.timelineStart / rate;
    const end = offset + child.timelineEnd / rate;
    if (visit(child, { start, end, rate }) === false) continue;
    if (child.type === "composition") {
      walkResolved(child.children, visit, start, rate * child.speed);
    } else {
      const kids = asExtensionNode(child)?.children;
      if (kids) walkResolved(kids, visit, start, rate);
    }
  }
}

export type FlatLeaf =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedData
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
