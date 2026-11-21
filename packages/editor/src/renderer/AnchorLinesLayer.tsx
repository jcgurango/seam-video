// SVG overlay drawn on top of the timeline panel. For every selected run head
// with an explicit `start` — at any editable level — draws a labelled plumb
// line at its anchor point: from the point on the sibling it anchors to down
// to the node's row, or, for an absolute (numeric) `start`, through the
// node's own row at that time, in a different colour (its handle moves the
// start along the time axis; there are no units to toggle). When
// `history` is provided (editable), the line is interactive: the top half /
// handle drags the anchor point (click the handle to toggle source seconds ↔
// percent), the bottom half / handle drags the node's `offset`.
//
// Each editable container is handled in its own (un-windowed) local scope:
// the anchor math runs against that container's authored body + local
// resolved children, and commits route through `editContainer` so a nested
// node edits the right sub-composition. Lines are positioned in content
// coordinates via each group's placement (containerLeft/Top + window
// transform), so one SVG covers the whole tree without clipping.
//
// Pure dependencies (computePointTime, dragAnchorPoint, etc.) live in
// anchorEdit.ts. This file is the React-side glue.

import React from "react";
import type { BinEntry, ResolvedChild, SeamFile, Start } from "@seam/core";
import type { History } from "./useHistory.js";
import {
  anchorPointKind,
  anchorSource,
  computePointTime,
  dragAnchorPoint,
  dragOffset,
  findAnchorById,
  nodeAnchor,
  setPlacement,
  toggleAnchorPoint,
  type AnchorEditCtx,
} from "./anchorEdit.js";
import { rowTop } from "./timelineLayout.js";
import {
  editContainer,
  getCompAtPath,
  parsePath,
  samePath,
  type NodePath,
} from "./nodePath.js";
import type { GroupPlacement } from "./dropRegions.js";

interface AnchorLineSpec {
  key: string;
  containerPath: NodePath;
  topX: number;
  topY: number;
  bottomX: number;
  bottomY: number;
  topLabel: "s" | "%";
  /** True for an absolute (numeric) `start` — no sibling, no unit toggle. */
  absolute: boolean;
  /** The container's window scale (output px → local seconds). */
  scale: number;
  edit: AnchorEditCtx;
}

export interface AnchorLinesLayerProps {
  /** Selection path keys; nodes with an anchored `start` draw lines. */
  selection: string[];
  /** Full root document — containers are resolved by path. */
  docRoot?: SeamFile;
  /** Root bin, injected when committing a nested-container edit. */
  rootBin: BinEntry[];
  /** Editable group placements (content-space origins) from `flattenGroups`. */
  groups: GroupPlacement[];
  pxPerSec: number;
  /** Provided only when editing is allowed. */
  history?: History<SeamFile>;
}

export default function AnchorLinesLayer({
  selection,
  docRoot,
  rootBin,
  groups,
  pxPerSec,
  history,
}: AnchorLinesLayerProps) {
  if (!docRoot) return null;

  const lines: AnchorLineSpec[] = [];

  for (const placement of groups) {
    const { group, containerLeft, containerTop } = placement;
    // The container's authored body + its local (un-windowed) resolved
    // children, reconstructed from the group's blocks.
    const authored = getCompAtPath(docRoot, group.path);
    if (!authored) continue;
    const children = authored.children ?? [];
    const resolvedChildren: ResolvedChild[] = [];
    const rowByIndex = new Map<number, number>();
    for (const b of group.blocks) {
      resolvedChildren[b.index] = b.child;
      rowByIndex.set(b.index, b.row);
    }
    const toX = (t: number) =>
      containerLeft + ((t - group.originSec) / group.scale) * pxPerSec;
    const yTop = (row: number) => containerTop + rowTop(row);

    for (const key of selection) {
      const path = parsePath(key);
      const last = path[path.length - 1];
      if (!last || last.field !== "children") continue;
      if (!samePath(path.slice(0, -1), group.path)) continue;

      const index = last.index;
      const nodeDoc = children[index];
      const nodeRow = rowByIndex.get(index);
      if (!nodeDoc || nodeRow == null) continue;
      const nodeStart = (nodeDoc as { start?: Start }).start;
      if (typeof nodeStart === "number") {
        // Absolute start: the "point" is that time on the container's axis.
        const y0 = yTop(nodeRow);
        const x = toX(nodeStart);
        lines.push({
          key,
          containerPath: group.path,
          topX: x,
          topY: y0 - 10,
          bottomX: x,
          bottomY: y0 + 32 + 10,
          topLabel: "s",
          absolute: true,
          scale: group.scale,
          edit: {
            index,
            pointTime: nodeStart,
            anchorStart: 0,
            anchorEnd: 0,
            anchorBase: 0,
            anchorSpeed: 1,
          },
        });
        continue;
      }
      const anchor = nodeAnchor(nodeStart);
      if (!anchor) continue;

      const found = findAnchorById(anchor.id, children, resolvedChildren);
      if (!found) continue;
      const anchorRow = rowByIndex.get(found.index);
      if (anchorRow == null) continue;

      const pointTime = computePointTime(anchor, found.doc, found.resolved);

      // The line is a plumb line dropped from the anchor point — always
      // vertical at the point's content-x, regardless of where the node's
      // start (point + offset) lands.
      const anchorY0 = yTop(anchorRow);
      const nodeY0 = yTop(nodeRow);
      const EXT = 10;
      const ROW_H = 32;
      let anchorOuterY: number;
      let nodeOuterY: number;
      if (anchorRow < nodeRow) {
        anchorOuterY = anchorY0 - EXT;
        nodeOuterY = nodeY0 + ROW_H + EXT;
      } else if (anchorRow > nodeRow) {
        anchorOuterY = anchorY0 + ROW_H + EXT;
        nodeOuterY = nodeY0 - EXT;
      } else {
        anchorOuterY = anchorY0 - EXT;
        nodeOuterY = anchorY0 + ROW_H + EXT;
      }

      const { base, speed } = anchorSource(found.doc, found.resolved);
      const lineX = toX(pointTime);
      lines.push({
        key,
        containerPath: group.path,
        topX: lineX,
        topY: anchorOuterY,
        bottomX: lineX,
        bottomY: nodeOuterY,
        topLabel: anchorPointKind(anchor),
        absolute: false,
        scale: group.scale,
        edit: {
          index,
          pointTime,
          anchorStart: found.resolved.timelineStart,
          anchorEnd: found.resolved.timelineEnd,
          anchorBase: base,
          anchorSpeed: speed,
        },
      });
    }
  }

  if (lines.length === 0) return null;

  const RADIUS = 9;
  const STROKE = "#ffcc00";
  const ABSOLUTE_STROKE = "#4ad0ff";
  const HIT_THICKNESS = 14;
  const CLICK_THRESHOLD_PX = 4;
  const editable = history != null;

  // Begin a drag (or click+drag from the top handle). `kind` selects which
  // field moves; `clickToggle` runs on pointerup if the user never crossed
  // the movement threshold.
  //
  // Explicit pointer capture on the originating SVG element keeps the drag
  // alive across the state-driven re-renders each `replace` triggers.
  const startEdit = (
    e: React.PointerEvent,
    containerPath: NodePath,
    ctx: AnchorEditCtx,
    kind: "anchorPoint" | "offset",
    clickToggle: ((start: Start) => Start) | null,
    scale = 1,
  ) => {
    e.stopPropagation();
    if (!history) return;
    e.preventDefault();
    const target = e.currentTarget as Element;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const initialDoc = history.current;
    const container = getCompAtPath(initialDoc, containerPath);
    const initialNode = container?.children?.[ctx.index] as
      | { start?: Start; offset?: number }
      | undefined;
    const initialStart = initialNode?.start;
    if (initialStart == null) return;
    const initialOffset = initialNode?.offset;

    // Commit a new placement for this node in its (possibly nested)
    // container — `editContainer` injects the root bin so nested binItems
    // still resolve, then splices the result back at the path.
    const commit = (start: Start, offset: number | undefined): SeamFile =>
      editContainer(initialDoc, containerPath, rootBin, (sub) =>
        setPlacement(sub, ctx.index, start, offset),
      );

    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* element gone — fall back to ambient pointer events */
    }

    let pastSnapshot = false;
    let dragging = !clickToggle; // line halves are pure-drag
    if (dragging) {
      history.pushPast(initialDoc);
      pastSnapshot = true;
    }

    const onMove = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > CLICK_THRESHOLD_PX) {
        dragging = true;
        if (!pastSnapshot) {
          history.pushPast(initialDoc);
          pastSnapshot = true;
        }
      }
      if (!dragging) return;
      // A nested group compresses time by its window scale.
      const deltaSec = (dx / pxPerSec) * scale;
      history.replace(
        kind === "anchorPoint"
          ? commit(dragAnchorPoint(initialStart, deltaSec, ctx), initialOffset)
          : commit(initialStart, dragOffset(initialOffset, deltaSec)),
      );
    };
    const onUp = (ev: Event) => {
      const me = ev as PointerEvent;
      if (me.pointerId !== pointerId) return;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      if (!dragging && clickToggle) {
        history.push(commit(clickToggle(initialStart), initialOffset));
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      {lines.map((l) => {
        const midX = (l.topX + l.bottomX) / 2;
        const midY = (l.topY + l.bottomY) / 2;
        const stroke = l.absolute ? ABSOLUTE_STROKE : STROKE;
        return (
          <g key={l.key}>
            {/* Top-half hit area — drag anchorPoint. */}
            <line
              x1={l.topX}
              y1={l.topY}
              x2={midX}
              y2={midY}
              stroke="transparent"
              strokeWidth={HIT_THICKNESS}
              style={{
                pointerEvents: editable ? "stroke" : "none",
                cursor: editable ? "grab" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.containerPath, l.edit, "anchorPoint", null, l.scale)
              }
            />
            {/* Bottom-half hit area — drag offset. */}
            <line
              x1={midX}
              y1={midY}
              x2={l.bottomX}
              y2={l.bottomY}
              stroke="transparent"
              strokeWidth={HIT_THICKNESS}
              style={{
                pointerEvents: editable ? "stroke" : "none",
                cursor: editable ? "grab" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.containerPath, l.edit, "offset", null, l.scale)
              }
            />
            {/* Visible cosmetic line. */}
            <line
              x1={l.topX}
              y1={l.topY}
              x2={l.bottomX}
              y2={l.bottomY}
              stroke={stroke}
              strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
            {/* Top circle — drag to move the point; click toggles its units
                (anchored starts only). */}
            <circle
              cx={l.topX}
              cy={l.topY}
              r={RADIUS}
              fill={stroke}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? (l.absolute ? "grab" : "pointer") : "default",
              }}
              onPointerDown={(e) =>
                startEdit(
                  e,
                  l.containerPath,
                  l.edit,
                  "anchorPoint",
                  // An absolute start has no units to toggle — drag only.
                  l.absolute ? null : (start) => toggleAnchorPoint(start, l.edit),
                  l.scale,
                )
              }
            />
            <text
              x={l.topX}
              y={l.topY}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#1e1e1e"
              fontSize={10}
              fontWeight={700}
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {l.topLabel}
            </text>
            {/* Bottom circle — drag the node's offset. */}
            <circle
              cx={l.bottomX}
              cy={l.bottomY}
              r={RADIUS}
              fill={stroke}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? "grab" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.containerPath, l.edit, "offset", null, l.scale)
              }
            />
            <text
              x={l.bottomX}
              y={l.bottomY}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#1e1e1e"
              fontSize={10}
              fontWeight={700}
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              s
            </text>
          </g>
        );
      })}
    </svg>
  );
}
