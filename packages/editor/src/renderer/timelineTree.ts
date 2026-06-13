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
  isExpanded: boolean;
  /** Present when `isExpanded` and the body resolved: the nested group +
   *  the local row its `overflow:hidden` container begins at. */
  expansion?: { group: TreeGroup; topRow: number };
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
  /** Whether the authored body backing this group can be edited in place
   *  (1:1 with the doc). False for `binItem` expansions (their body lives
   *  in the shared bin entry, a Phase-3 concern), so those render but
   *  don't select/resize/reorder. */
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
      rowEnds.push(it.child.timelineEnd);
    } else {
      rowEnds[row] = it.child.timelineEnd;
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
  // A `binItem` expansion's body lives in the shared bin entry, not under
  // this node — editing it is a Phase-3 concern, so its subtree is laid out
  // read-only (editable=false) and keeps the position-path only for
  // expand-state keying.
  const childEditable = editable && !docComp?.binItem;
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
    block.path,
    childEditable,
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
    const { placed, rows: bandRows } = packBand(items, 0);
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
          isExpanded: isComposition && expanded.has(addr),
        };
        blocks.push(block);
        if (block.isExpanded) toExpand.push(block);
      }
      cursor += 1;
      if (toExpand.length > 0) {
        const expBaseRow = cursor;
        let maxRows = 0;
        for (const block of toExpand) {
          const group = buildExpansion(block, expanded, rootBin, editable);
          if (group) {
            block.expansion = { group, topRow: expBaseRow };
            maxRows = Math.max(maxRows, group.rowCount);
          }
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
