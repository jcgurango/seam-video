import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedAudio,
  ResolvedEmpty,
  ResolvedData,
  ResolvedHtml,
} from "./resolved-types.js";

export type FlatLeaf =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedEmpty
  | ResolvedData
  | ResolvedHtml;

/**
 * Flatten a resolved tree into a linear list of leaves (clips, audios,
 * empties, data). Compounds speed and offsets through nested compositions.
 */
export function flattenResolved(
  children: ResolvedChild[],
  parentOffset = 0,
  parentSpeed = 1
): FlatLeaf[] {
  const result: FlatLeaf[] = [];

  for (const child of children) {
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
      });
    } else if (child.type === "empty") {
      result.push({
        type: "empty",
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (child.type === "data") {
      result.push({
        type: "data",
        data: child.data,
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (child.type === "html") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
      });
    } else {
      // Composition: recurse with compounded speed and offset
      const compoundSpeed = child.speed * parentSpeed;
      const innerFlat = flattenResolved(child.children, start, compoundSpeed);
      result.push(...innerFlat);
    }
  }

  return result;
}
