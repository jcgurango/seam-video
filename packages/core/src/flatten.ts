import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedEmpty,
} from "./resolved-types.js";

/**
 * Flatten a resolved tree into a linear list of clips and empties.
 * Compounds speed and offsets through nested compositions.
 */
export function flattenResolved(
  children: ResolvedChild[],
  parentOffset = 0,
  parentSpeed = 1
): (ResolvedClip | ResolvedEmpty)[] {
  const result: (ResolvedClip | ResolvedEmpty)[] = [];

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
    } else if (child.type === "empty") {
      result.push({
        type: "empty",
        timelineStart: start,
        timelineEnd: end,
      });
    } else {
      // Composition or overlay: recurse with compounded speed and offset
      const compoundSpeed = child.speed * parentSpeed;
      const innerFlat = flattenResolved(child.children, start, compoundSpeed);
      result.push(...innerFlat);
    }
  }

  return result;
}
