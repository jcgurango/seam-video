import type {
  ResolvedChild,
  ResolvedClip,
  ResolvedAudio,
  ResolvedStatic,
  ResolvedEmpty,
  ResolvedData,
  ResolvedGraphic,
  ResolvedText,
} from "./resolved-types.js";

export type FlatLeaf =
  | ResolvedClip
  | ResolvedAudio
  | ResolvedStatic
  | ResolvedEmpty
  | ResolvedData
  | ResolvedText
  | ResolvedGraphic;

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
        ...(child.volume != null ? { volume: child.volume } : {}),
      });
    } else if (child.type === "static") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
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
        ...(child.tags?.length ? { tags: child.tags } : {}),
      });
    } else if (child.type === "text") {
      result.push({
        ...child,
        timelineStart: start,
        timelineEnd: end,
      });
    } else if (child.type === "graphic") {
      // Graphic is a leaf for layout purposes — the renderer/preview
      // drives the internal animation playhead; flatten just hands the
      // resolved node downstream.
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
