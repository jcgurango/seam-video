// Map the global playhead into a nested container's local (inner-timeline)
// time, by walking the resolved tree down a path.
//
// The resolver keeps each composition's children in that composition's own
// *inner* timeline coordinates (0-based, un-windowed, un-sped — a clip inside
// a 2x composition still resolves to its full source span). The comp's
// `speed` / `in`/`out` describe how that inner timeline maps to the comp's
// output. So descending one level is:
//   inner = (comp.in ?? 0) + (parentTime - comp.timelineStart) * comp.speed
// (For the common non-windowed comp this is just `(t - start) * speed`.)
//
// Used by the toolbar slice (find the playhead inside a sub-composition) and
// attach (compute a source anchor point on a nested primary).

import type {
  Child,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
} from "@seam/core";
import type { NodePath } from "./nodePath.js";

interface ResolvedBody {
  children: ResolvedChild[];
}
interface AuthoredBody {
  children: Child[];
  attachments?: Child[];
}

export interface ContainerLocal {
  /** The global playhead expressed in the container's child-coordinate time. */
  localTime: number;
  /** Resolved container — its `children` are the resolved child band. */
  rContainer: ResolvedBody;
  /** Authored container. */
  aContainer: AuthoredBody;
}

/** Descend `containerPath` (non-bin), mapping `globalTime` into the
 *  container's local inner-timeline time. Returns null if any segment isn't a
 *  composition that resolves 1:1 (a bin root, or a narrowing-windowed crop —
 *  the acknowledged edge). `containerPath` = [] yields the root unchanged. */
export function descendToContainer(
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  containerPath: NodePath,
  globalTime: number,
): ContainerLocal | null {
  let t = globalTime;
  let rNode: ResolvedBody = resolvedRoot;
  let aNode: AuthoredBody = doc;
  for (const seg of containerPath) {
    if (seg.field === "bin") return null;
    const childCount = aNode.children.length;
    const flat = seg.field === "children" ? seg.index : childCount + seg.index;
    const rChild = rNode.children[flat];
    if (!rChild || rChild.type !== "composition") return null;
    const aChild =
      seg.field === "children"
        ? aNode.children[seg.index]
        : (aNode.attachments ?? [])[seg.index];
    if (!aChild || aChild.type !== "composition") return null;
    t = (aChild.in ?? 0) + (t - rChild.timelineStart) * rChild.speed;
    rNode = rChild;
    aNode = aChild;
  }
  return { localTime: t, rContainer: rNode, aContainer: aNode };
}
