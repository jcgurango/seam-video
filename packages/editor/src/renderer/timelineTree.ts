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
  resolveComposition,
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

interface AuthoredBody {
  children: Child[];
  attachments?: Child[];
}

/** A single block within one group, positioned in that group's local
 *  seconds (`child.timelineStart` is the x origin; `row` is local). */
export interface TreeBlock {
  child: ResolvedChild;
  /** Flat index within the group's resolved children (children then
   *  appended attachments) — used for reorder ordering + anchor-line rows. */
  index: number;
  row: number;
  isAttachment: boolean;
  /** Position path from the root composition (`children.0`,
   *  `children.3.attachments.1`). Also the selection / expand-state key. */
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
export interface TreeGroup {
  blocks: TreeBlock[];
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

function packBand(
  items: { child: ResolvedChild; index: number }[],
  baseRow: number,
): { placed: { child: ResolvedChild; index: number; row: number }[]; rows: number } {
  const sorted = [...items].sort(
    (a, b) => a.child.timelineStart - b.child.timelineStart,
  );
  const rowEnds: number[] = [];
  const placed: { child: ResolvedChild; index: number; row: number }[] = [];
  for (const it of sorted) {
    let row = rowEnds.findIndex((end) => end <= it.child.timelineStart);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(Math.floor(it.child.timelineEnd * 1000) / 1000);
    } else {
      rowEnds[row] = Math.floor(it.child.timelineEnd * 1000) / 1000;
    }
    placed.push({ child: it.child, index: it.index, row: baseRow + row });
  }
  return { placed, rows: rowEnds.length };
}

/** Resolve a composition body's full (un-windowed) inner timeline. The
 *  body is wrapped in a synthetic composition carrying the root bin so any
 *  nested `binItem`s resolve; scripts are left off so authored children
 *  map 1:1. Returns the merged children (sequential + attachments) or null
 *  if it can't be resolved. */
function resolveBody(body: AuthoredBody, rootBin: BinEntry[]): ResolvedChild[] | null {
  try {
    const synthetic: Composition = {
      type: "composition",
      children: body.children,
      ...(body.attachments ? { attachments: body.attachments } : {}),
      ...(rootBin.length ? { bin: rootBin } : {}),
    };
    const { doc } = compileDocument(synthetic, { runScripts: false });
    return resolveComposition(doc as Composition).children;
  } catch {
    return null;
  }
}

function buildExpansion(
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
  const expansionPath: NodePath = docComp?.binItem
    ? [{ field: "bin", index: 0, id: docComp.binItem }]
    : block.path;
  if (docComp?.binItem) {
    const entry = findBinItem(rootBin, docComp.binItem);
    body = entry
      ? { children: entry.children, attachments: entry.attachments }
      : undefined;
  } else if (docComp) {
    body = { children: docComp.children ?? [], attachments: docComp.attachments };
  }
  if (!body) return null;
  const resolved = resolveBody(body, rootBin);
  if (!resolved) return null;
  // Window transform for the expansion: inner content is shifted left by
  // the reference's `in` and compressed by the resolved window speed, so
  // it aligns under the (windowed) composition block and the clip
  // container trims the rest.
  const originSec = docComp?.in ?? 0;
  const scale = (block.child as ResolvedComposition).speed || 1;
  return layoutGroup(
    resolved,
    body.children.length,
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
  resolved: ResolvedChild[],
  split: number,
  authored: AuthoredBody | undefined,
  expanded: Set<string>,
  rootBin: BinEntry[],
  parentPath: NodePath,
  editable: boolean,
  originSec: number,
  scale: number,
): TreeGroup {
  const docAt = (index: number, isAttachment: boolean): Child | undefined =>
    !authored
      ? undefined
      : isAttachment
        ? authored.attachments?.[index - split]
        : authored.children[index];

  const blocks: TreeBlock[] = [];
  let cursor = 0;

  const emitBand = (items: { child: ResolvedChild; index: number }[], isAttachment: boolean) => {
    // Pack into band-local rows (0-based), then walk those rows top to
    // bottom. After each row, the expansions of the comps on it are laid
    // out at a *shared* base row (height = the tallest of them). So:
    //   • sibling comps on the same row (e.g. two back-to-back children)
    //     get their expansions side by side, sharing rows — not stacked;
    //   • an expanded composition's expansion lands immediately below its
    //     own row and pushes lower rows down (so an attachment-comp's
    //     window sits between it and the next attachment).
    // Sequential children share one row and are placed in authored order:
    // they only ever overlap via a `transition` crossfade, and we *want*
    // that overlap to show (block left edges drawn at `timelineStart`), not
    // to bump the later child onto its own row. Attachments genuinely stack,
    // so they still pack into band-local rows.
    const { placed, rows: bandRows } = isAttachment
      ? packBand(items, 0)
      : {
          placed: items.map((it) => ({ child: it.child, index: it.index, row: 0 })),
          rows: items.length > 0 ? 1 : 0,
        };
    for (let r = 0; r < bandRows; r++) {
      const toExpand: TreeBlock[] = [];
      for (const p of placed) {
        if (p.row !== r) continue;
        const docChild = docAt(p.index, isAttachment);
        const isComposition = (docChild?.type ?? p.child.type) === "composition";
        const isBinItem =
          isComposition && !!(docChild as Composition | undefined)?.binItem;
        // Within-field (authored-array) index — attachments start at `split`
        // in the resolved/flat `index`, but at 0 in their own array.
        const fieldIndex = isAttachment ? p.index - split : p.index;
        const path: NodePath = [
          ...parentPath,
          { field: isAttachment ? "attachments" : "children", index: fieldIndex },
        ];
        const addr = pathKey(path);
        // A node is expandable when it's a composition (window) or has any
        // animated property (keyframe lanes). Non-comp animated nodes get
        // the expand toggle purely for their lanes.
        const hasLanes = hasAnimatedLanes(docChild);
        const expandable = isComposition || hasLanes;
        const block: TreeBlock = {
          child: p.child,
          index: p.index,
          row: cursor,
          isAttachment,
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
      cursor += 1;
      if (toExpand.length > 0) {
        const expBaseRow = cursor;
        let maxRows = 0;
        for (const block of toExpand) {
          // Composition window first (its own nested group), then keyframe
          // lanes below it. Both are local rows within this group; sibling
          // expansions on the same band row share `expBaseRow` (they sit at
          // different x, under their own blocks).
          let winRows = 0;
          if (block.isComposition) {
            const group = buildExpansion(block, expanded, rootBin, editable);
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
  };

  emitBand(
    resolved.slice(0, split).map((child, i) => ({ child, index: i })),
    false,
  );
  emitBand(
    resolved.slice(split).map((child, j) => ({ child, index: split + j })),
    true,
  );

  return { blocks, rowCount: cursor, originSec, scale, path: parentPath, editable };
}

/** Lay out the whole (possibly partially-expanded) timeline tree. The root
 *  body uses the identity transform (it isn't windowed) and is editable. */
export function layoutTree(
  resolved: ResolvedChild[],
  authored: AuthoredBody | undefined,
  attachmentStartIndex: number,
  expanded: Set<string>,
  rootBin: BinEntry[],
): TreeGroup {
  return layoutGroup(
    resolved,
    attachmentStartIndex,
    authored,
    expanded,
    rootBin,
    [],
    true,
    0,
    1,
  );
}
