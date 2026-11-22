// Map the global playhead into a nested container's local (inner-timeline)
// time, by walking the resolved tree down a path.
//
// A composition's children live in that composition's own *inner* timeline
// coordinates (0-based, un-windowed, un-sped — a clip inside a 2x
// composition still resolves to its full source span). The comp's
// `speed` / `in`/`out` describe how that inner timeline maps to the comp's
// output. So descending one level is:
//   inner = (comp.in ?? 0) + (parentTime - comp.timelineStart) * comp.speed
// (For the common non-windowed comp this is just `(t - start) * speed`.) A
// looping comp (`underflow: "loop"`) wraps `parentTime - timelineStart` into
// its current cycle first (`loopLocalTime`).
//
// Resolved children must map 1:1 onto authored children here, which the
// windowed/cropped resolved tree doesn't guarantee below the top level (a
// nested composition's resolved children are cropped to its window and to
// t ≥ 0, and rebased). So only the ROOT band is read from the caller's
// resolved timeline (which must be resolved `uncropped`); every nested
// container is re-resolved on its own, `uncropped`, from the compiled doc —
// its children then sit in the same un-windowed inner coordinates as
// `localTime`.
//
// Used by the toolbar slice (find the playhead inside a sub-composition) and
// attach (compute a source anchor point on a nested primary).

import { loopLocalTime } from "@seam/core";
import type {
  Seam,
  Child,
  Composition,
  ResolvedChild,
  ResolvedComposition,
  ResolvedTimeline,
  SeamFile,
} from "@seam/core";
import type { NodePath } from "./nodePath.js";

interface ResolvedBody {
  children: ResolvedChild[];
}
interface AuthoredBody {
  children?: Child[];
}

export interface ContainerLocal {
  /** The global playhead expressed in the container's child-coordinate time. */
  localTime: number;
  /** Resolved container — its `children` are 1:1 with the authored
   *  container's, in the container's un-windowed inner coordinates. */
  rContainer: ResolvedBody;
  /** Authored container. */
  aContainer: AuthoredBody;
}

/** One step down the path: the composition at `index` of the current
 *  container, its resolved placement in that container, and its own resolved
 *  body (un-cropped, 1:1 with its authored children). */
interface Level {
  /** The container's resolved placement. An extension container (a caption,
   *  a map) is presented with a composition's time fields: speed 1, no loop. */
  rChild: { timelineStart: number; timelineEnd: number; speed: number; loop?: ResolvedComposition["loop"] };
  /** The authored container; `in` is 0 for an extension container. */
  aChild: { in?: number; children?: Child[] };
  rBody: ResolvedBody;
}

/** Walk `containerPath` from the root, calling `visit` per composition
 *  entered. Returns the final container, or null when a segment is a bin
 *  root, isn't a composition, or can't be resolved. */
function walkContainers(
  seam: Seam,
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  containerPath: NodePath,
  visit: (level: Level) => void,
): { rContainer: ResolvedBody; aContainer: AuthoredBody } | null {
  let rNode: ResolvedBody = resolvedRoot;
  let aNode: AuthoredBody = doc;
  // The compiled twin of `aNode` (bins inflated, scripts skipped — same
  // shape as the authored tree), so nested `binItem`s have real durations.
  let cNode: AuthoredBody | null = null;
  for (const seg of containerPath) {
    if (seg.field === "bin") return null;
    cNode ??= seam.compileSeamFile(doc, { runScripts: false }).doc;
    const rChild = rNode.children[seg.index];
    const aChild = (aNode.children ?? [])[seg.index];
    const cChild: Child | undefined = (cNode.children ?? [])[seg.index];
    if (!rChild || !aChild || !cChild) return null;
    if (rChild.type !== "composition" || aChild.type !== "composition" || cChild.type !== "composition") {
      // An extension container: its children play in its own time from 0,
      // at speed 1, un-windowed.
      const kids: Child[] | undefined = (cChild as { children?: Child[] }).children;
      if (!("extension" in rChild) || !Array.isArray(kids)) return null;
      let rBody: ResolvedBody;
      try {
        rBody = seam.resolveComposition({ type: "composition", children: kids } as Composition, { uncropped: true });
      } catch {
        return null;
      }
      const standIn = { children: (aChild as { children?: Child[] }).children ?? [] };
      visit({ rChild: { timelineStart: rChild.timelineStart, timelineEnd: rChild.timelineEnd, speed: 1 }, aChild: standIn, rBody });
      rNode = rBody;
      aNode = standIn;
      cNode = { children: kids };
      continue;
    }
    let rBody: ResolvedBody;
    try {
      rBody = seam.resolveComposition(cChild, { uncropped: true });
    } catch {
      return null;
    }
    visit({ rChild, aChild, rBody });
    rNode = rBody;
    aNode = aChild;
    cNode = cChild;
  }
  return { rContainer: rNode, aContainer: aNode };
}

/** Descend `containerPath` (non-bin), mapping `globalTime` into the
 *  container's local inner-timeline time. Returns null if any segment isn't
 *  a resolvable composition (or is a bin root). `containerPath` = [] yields
 *  the root unchanged. `resolvedRoot` must be 1:1 with `doc.children`
 *  (resolved `uncropped`). */
export function descendToContainer(
  seam: Seam,
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  containerPath: NodePath,
  globalTime: number,
): ContainerLocal | null {
  let t = globalTime;
  const end = walkContainers(seam, resolvedRoot, doc, containerPath, ({ rChild, aChild }) => {
    // A looping comp replays its window: wrap into the current cycle first.
    t = (aChild.in ?? 0) + loopLocalTime(rChild.loop, t - rChild.timelineStart) * rChild.speed;
  });
  return end ? { localTime: t, ...end } : null;
}

export interface Span {
  start: number;
  end: number;
}

/** The node's resolved [timelineStart, timelineEnd] mapped up into GLOBAL
 *  output time, walking the enclosing compositions' inner→output transforms
 *  (`parent = timelineStart + (inner − in) / speed` per level). Null for
 *  bin-rooted paths or when any level doesn't resolve. */
export function globalSpanOf(
  seam: Seam,
  resolvedRoot: ResolvedTimeline,
  doc: SeamFile,
  path: NodePath,
): Span | null {
  if (path.length === 0) return null;
  const last = path[path.length - 1];
  if (last.field === "bin") return null;
  let toGlobal = (t: number) => t;
  const end = walkContainers(seam, resolvedRoot, doc, path.slice(0, -1), ({ rChild, aChild }) => {
    const start = rChild.timelineStart;
    const speed = rChild.speed;
    const inVal = aChild.in ?? 0;
    const prev = toGlobal;
    toGlobal = (t) => prev(start + (t - inVal) / speed);
  });
  const rNode = end?.rContainer.children[last.index];
  if (!rNode) return null;
  return { start: toGlobal(rNode.timelineStart), end: toGlobal(rNode.timelineEnd) };
}
