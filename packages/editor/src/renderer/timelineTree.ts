// Recursive timeline layout for expandable compositions.
//
// The shape here is deliberately a *tree*, not a flat block list: each
// expanded composition becomes its own group, rendered (by
// `<TimelineGroup>`) inside an `overflow: hidden` container positioned at
// the composition's window. That keeps three properties the flat approach
// couldn't:
//   • clipping is structural (the container clips), so once interactions
//     land, moving a child past the edge clips it rather than deleting it
//     from view;
//   • coordinates stay local to each group (a block's x is just
//     `child.timelineStart * pxPerSec` inside its own container);
//   • no single component owns the whole tree — each group renders only
//     its own body and defers nested compositions to nested groups.
//
// A group's inner content is the composition's body resolved *un-windowed*
// (the full inner timeline), so a narrowing `in`/`out` window simply clips
// the overflow rather than dropping children. Bin-item references resolve
// the shared bin entry's body; regular compositions resolve their own.

import {
  runsOf,
  type BinEntry,
  type Child,
  type Composition,
  type ResolvedChild,
  type ResolvedComposition,
} from "@seam/core";
import { compileDocument } from "./compile.js";
import { findBinItem } from "./nodeBin.js";
import { pathKey, type NodePath } from "./nodePath.js";
import { hasAnimatedLanes, lanesForNode, type KeyframeLane } from "./keyframeLanes.js";
import type { Seam } from "@seam/core";

interface AuthoredBody {
  children?: Child[];
}

/** A single block within one group, positioned in that group's local
 *  seconds (`child.timelineStart` is the x origin; `row` is local). */
export interface TreeBlock {
  child: ResolvedChild;
  /** Index within the container's `children` (authored = resolved order). */
  index: number;
  row: number;
  /** Index into the group's `runs` of the run this block belongs to. */
  run: number;
  /** True when this block heads its run. */
  isHead: boolean;
  /** Position path from the root composition (`children.0`,
   *  `children.3.children.1`). Also the selection / expand-state key. */
  path: NodePath;
  addr: string;
  docChild?: Child;
  isComposition: boolean;
  isBinItem: boolean;
  /** True when the node has any animated property (so it's expandable to
   *  show keyframe lanes even when it isn't a composition). */
  hasLanes: boolean;
  isExpanded: boolean;
  /** Present when `isExpanded` and the body resolved: the nested group +
   *  the local row its `overflow:hidden` container begins at. */
  expansion?: { group: TreeGroup; topRow: number };
  /** Present when `isExpanded` and the node has animated properties: one
   *  keyframe lane per property, plus the local row the lanes begin at
   *  (below any composition window). One standard row per lane. */
  lanes?: KeyframeLane[];
  laneTopRow?: number;
}

/** One composition body laid out: its blocks (in the body's own inner
 *  timeline seconds) and the total number of rows it occupies, including
 *  nested expansion containers. `originSec`/`scale` are the window
 *  transform from the *enclosing* composition: a block's displayed x is
 *  `(child.timelineStart - originSec) / scale * pxPerSec`, so a window
 *  `in` shifts content left and `out`/overflow speed compresses it (the
 *  `overflow:hidden` container then clips what falls outside). The root
 *  group is the identity transform (0, 1). */
/** One run laid out: a contiguous slice `[head, end)` of the container's
 *  `children`, on one row, spanning `[startSec, endSec]` of local time. */
export interface TreeRun {
  head: number;
  end: number;
  row: number;
  startSec: number;
  endSec: number;
}

export interface TreeGroup {
  blocks: TreeBlock[];
  /** The container's runs in array (z) order. */
  runs: TreeRun[];
  rowCount: number;
  originSec: number;
  scale: number;
  /** The container path these blocks live under ([] = root). Their own
   *  paths are this + a `{field, index}` segment. */
  path: NodePath;
  /** Whether the authored body backing this group can be edited in place.
   *  True for the root, regular-composition expansions, and `binItem`
   *  expansions alike (the latter address a `bin.<id>` root, so edits
   *  rewrite the shared entry). Reserved for any future read-only case. */
  editable: boolean;
}

/** Resolve a composition body's full (un-windowed, un-cropped) inner
 *  timeline. The body is wrapped in a synthetic composition carrying the
 *  root bin so any nested `binItem`s resolve; scripts are left off and the
 *  resolve is `uncropped`, so resolved children map 1:1 onto authored ones.
 *  Returns null if it can't be resolved. */
function resolveBody(seam: Seam, body: AuthoredBody, rootBin: BinEntry[]): ResolvedChild[] | null {
  try {
    const synthetic: Composition = {
      type: "composition",
      children: body.children,
      ...(rootBin.length ? { bin: rootBin } : {}),
    };
    const { doc } = compileDocument(seam, synthetic, { runScripts: false });
    return seam.resolveComposition(doc as Composition, { uncropped: true }).children;
  } catch {
    return null;
  }
}

/** Run slices for a resolved list. With the authored body they come straight
 *  from `start` fields; a read-only preview (no document) infers them — a
 *  node continues the run when it starts where the previous one ends, or
 *  cross-fades with it. */
function runSlices(resolved: ResolvedChild[], authored: AuthoredBody | undefined): [number, number][] {
  if (authored) {
    const kids = (authored.children ?? []).slice(0, resolved.length);
    if (kids.length === resolved.length) return runsOf(kids);
  }
  const runs: [number, number][] = [];
  for (let i = 0; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    const continues =
      i > 0 &&
      (Math.abs(cur.timelineStart - prev.timelineEnd) < 1e-6 ||
        (cur as { transition?: number }).transition != null);
    if (continues) runs[runs.length - 1][1] = i + 1;
    else runs.push([i, i + 1]);
  }
  return runs;
}

/** Pack runs into rows. Array order is z-order, so a run goes strictly below
 *  every EARLIER run it overlaps in time; runs that never overlap share rows
 *  (z doesn't matter between them). */
function packRuns(resolved: ResolvedChild[], slices: [number, number][]): TreeRun[] {
  const runs: TreeRun[] = [];
  for (const [head, end] of slices) {
    let startSec = Infinity;
    let endSec = -Infinity;
    for (let i = head; i < end; i++) {
      startSec = Math.min(startSec, resolved[i].timelineStart);
      endSec = Math.max(endSec, resolved[i].timelineEnd);
    }
    let row = 0;
    for (const r of runs) {
      const overlaps = startSec < r.endSec - 1e-3 && r.startSec < endSec - 1e-3;
      if (overlaps && r.row >= row) row = r.row + 1;
    }
    runs.push({ head, end, row, startSec, endSec });
  }
  return runs;
}

function buildExpansion(
  seam: Seam,
  block: TreeBlock,
  expanded: Set<string>,
  rootBin: BinEntry[],
  editable: boolean,
): TreeGroup | null {
  const docComp = block.docChild as Composition | undefined;
  let body: AuthoredBody | undefined;
  // A `binItem` expansion's body lives in the shared bin entry, so its
  // subtree is addressed at a `bin.<id>` root — editing it rewrites the
  // entry and propagates to every reference (Phase 3). A regular
  // composition's children are addressed under the reference's own path.
  const binId = docComp && "binItem" in docComp ? docComp.binItem : undefined;
  const expansionPath: NodePath = binId
    ? [{ field: "bin", index: 0, id: binId }]
    : block.path;
  if (binId) {
    const entry = findBinItem(rootBin, binId);
    body = entry ? { children: entry.children } : undefined;
  } else if (docComp) {
    body = { children: docComp.children ?? [] };
  }
  if (!body) return null;
  const resolved = resolveBody(seam, body, rootBin);
  if (!resolved) return null;
  // Window transform for the expansion: inner content is shifted left by
  // the reference's `in` and compressed by the resolved window speed, so
  // it aligns under the (windowed) composition block and the clip
  // container trims the rest.
  const originSec = docComp?.in ?? 0;
  const scale = (block.child as ResolvedComposition).speed || 1;
  return layoutGroup(seam,
    resolved,
    body,
    expanded,
    rootBin,
    expansionPath,
    editable,
    originSec,
    scale,
  );
}

function layoutGroup(
  seam: Seam,
  resolved: ResolvedChild[],
  authored: AuthoredBody | undefined,
  expanded: Set<string>,
  rootBin: BinEntry[],
  parentPath: NodePath,
  editable: boolean,
  originSec: number,
  scale: number,
): TreeGroup {
  const packed = packRuns(resolved, runSlices(resolved, authored));
  const packedRows = packed.reduce((m, r) => Math.max(m, r.row + 1), 0);

  const blocks: TreeBlock[] = [];
  const runs: TreeRun[] = packed.map((r) => ({ ...r }));
  let cursor = 0;

  // Walk the packed rows top to bottom. After each row, the expansions of
  // the blocks on it are laid out at a *shared* base row (height = the
  // tallest of them), so sibling comps on one row expand side by side and an
  // expansion lands immediately below its own row, pushing lower rows down.
  // A run's members share its row: they only overlap via a negative-offset
  // crossfade, and we *want* that overlap to show.
  for (let r = 0; r < packedRows; r++) {
    const toExpand: TreeBlock[] = [];
    packed.forEach((run, runIndex) => {
      if (run.row !== r) return;
      runs[runIndex].row = cursor;
      for (let index = run.head; index < run.end; index++) {
        const child = resolved[index];
        const docChild = authored?.children?.[index];
        const isComposition = (docChild?.type ?? child.type) === "composition";
        const isBinItem = isComposition && !!docChild && "binItem" in docChild;
        const path: NodePath = [...parentPath, { field: "children", index }];
        const addr = pathKey(path);
        // A node is expandable when it's a composition (window) or has any
        // animated property (keyframe lanes).
        const hasLanes = hasAnimatedLanes(docChild);
        const expandable = isComposition || hasLanes;
        const block: TreeBlock = {
          child,
          index,
          row: cursor,
          run: runIndex,
          isHead: index === run.head,
          path,
          addr,
          docChild,
          isComposition,
          isBinItem,
          hasLanes,
          isExpanded: expandable && expanded.has(addr),
        };
        blocks.push(block);
        if (block.isExpanded) toExpand.push(block);
      }
    });
    cursor += 1;
    if (toExpand.length > 0) {
      const expBaseRow = cursor;
      let maxRows = 0;
      for (const block of toExpand) {
        // Composition window first (its own nested group), then keyframe
        // lanes below it. Sibling expansions on the same row share
        // `expBaseRow` (they sit at different x, under their own blocks).
        let winRows = 0;
        if (block.isComposition) {
          const group = buildExpansion(seam, block, expanded, rootBin, editable);
          if (group) {
            block.expansion = { group, topRow: expBaseRow };
            winRows = group.rowCount;
          }
        }
        if (block.hasLanes && block.docChild) {
          const lanes = lanesForNode(block.docChild, block.child);
          if (lanes.length > 0) {
            block.lanes = lanes;
            block.laneTopRow = expBaseRow + winRows;
          }
        }
        maxRows = Math.max(maxRows, winRows + (block.lanes?.length ?? 0));
      }
      cursor += maxRows;
    }
  }

  // An empty container still shows one (empty) row to drop onto.
  return {
    blocks,
    runs,
    rowCount: Math.max(cursor, 1),
    originSec,
    scale,
    path: parentPath,
    editable,
  };
}

/** Lay out the whole (possibly partially-expanded) timeline tree. The root
 *  body uses the identity transform (it isn't windowed) and is editable. */
export function layoutTree(
  seam: Seam,
  resolved: ResolvedChild[],
  authored: AuthoredBody | undefined,
  expanded: Set<string>,
  rootBin: BinEntry[],
): TreeGroup {
  // With a document, re-resolve the body un-cropped so blocks stay 1:1 with
  // authored children even when some start before 0.
  const body = (authored && resolveBody(seam, authored, rootBin)) || resolved;
  return layoutGroup(seam,
    body,
    authored,
    expanded,
    rootBin,
    [],
    true,
    0,
    1,
  );
}
