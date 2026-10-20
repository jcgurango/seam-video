/**
 * The timeline as the byte planner sees it: every clip/audio leaf with its
 * absolute output placement and source window. Mirrors the preview's
 * `collectClips` walk (nested compositions keep children in inner coordinates:
 * inner = (t − comp.timelineStart) · comp.speed, clamped to the comp's inner
 * span). Pure.
 */
import type { ResolvedChild, ResolvedTimeline } from "@seam/core";

export interface Cut {
  /** Stable id (index path, e.g. `"3"`, `"3.1"`); used as the cache tag. */
  id: string;
  kind: "clip" | "audio";
  source: string;
  sourceIn: number;
  sourceOut: number;
  /** Absolute output time the cut occupies. */
  start: number;
  end: number;
}

export function cutsFromTimeline(
  timeline: ResolvedTimeline,
  mapSource: (source: string) => string = (s) => s,
): Cut[] {
  const out: Cut[] = [];
  walk(timeline.children, "", (t) => t, Infinity, mapSource, out);
  return out;
}

function walk(
  children: ResolvedChild[],
  prefix: string,
  toAbsolute: (innerT: number) => number,
  innerSpan: number,
  mapSource: (source: string) => string,
  out: Cut[],
): void {
  children.forEach((child, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (child.type === "clip" || child.type === "audio") {
      const innerStart = Math.max(0, child.timelineStart);
      const innerEnd = Math.min(child.timelineEnd, innerSpan);
      if (innerEnd <= innerStart) return;
      const sourceIn = child.sourceIn + (innerStart - child.timelineStart) * child.speed;
      const sourceOut = child.sourceIn + (innerEnd - child.timelineStart) * child.speed;
      out.push({
        id,
        kind: child.type,
        source: mapSource(child.source),
        sourceIn: Math.min(sourceIn, sourceOut),
        sourceOut: Math.max(sourceIn, sourceOut),
        start: toAbsolute(innerStart),
        end: toAbsolute(innerEnd),
      });
    } else if (child.type === "composition") {
      const comp = child;
      const childToAbsolute = (innerT: number) => toAbsolute(comp.timelineStart + innerT / comp.speed);
      walk(comp.children, id, childToAbsolute, comp.duration * comp.speed, mapSource, out);
    }
  });
}
