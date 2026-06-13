// SVG overlay drawn on top of the timeline panel. For every selected
// attachment — at any editable level — draws a labelled line from the
// anchor point on its referenced sibling to the attachment's row. When
// `history` is provided (editable), the line is interactive: drag halves
// adjust anchorPoint / offset, click circles toggle units between
// seconds and percent.
//
// Each editable container is resolved in its own (un-windowed) local
// scope: the anchor math runs against that container's authored body +
// local resolved children, and commits route through `editContainer` so a
// nested attachment edits the right sub-composition. Lines are positioned
// in content coordinates via each group's placement (containerLeft/Top +
// window transform), so one SVG covers the whole tree without clipping.
//
// Pure dependencies (computePointTime, dragAnchorPoint, etc.) live in
// anchorEdit.ts. This file is the React-side glue.

import React from "react";
import type {
  BinEntry,
  Child,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import type { History } from "./useHistory.js";
import {
  anchorPointKind,
  computePointTime,
  dragAnchorPoint,
  dragOffset,
  findAnchorById,
  naturalDurOf,
  offsetKind,
  setAttachmentSpec,
  toggleAnchorPoint,
  toggleOffset,
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
  bottomLabel: "s" | "%";
  edit: AnchorEditCtx;
}

export interface AnchorLinesLayerProps {
  /** Selection path keys; attachment keys (`…attachments.N`) draw lines. */
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
    const childCount = authored.children.length;
    const resolvedChildren: ResolvedChild[] = [];
    const rowByIndex = new Map<number, number>();
    for (const b of group.blocks) {
      resolvedChildren[b.index] = b.child;
      rowByIndex.set(b.index, b.row);
    }
    const localTimeline = { children: resolvedChildren } as ResolvedTimeline;
    const toX = (t: number) =>
      containerLeft + ((t - group.originSec) / group.scale) * pxPerSec;
    const yTop = (row: number) => containerTop + rowTop(row);

    for (const key of selection) {
      const path = parsePath(key);
      const last = path[path.length - 1];
      if (!last || last.field !== "attachments") continue;
      if (!samePath(path.slice(0, -1), group.path)) continue;

      const attIdx = last.index;
      const attDoc = authored.attachments?.[attIdx];
      const flatAttIndex = childCount + attIdx;
      const attResolved = resolvedChildren[flatAttIndex];
      if (!attDoc || !attResolved) continue;
      const attRow = rowByIndex.get(flatAttIndex);
      if (attRow == null) continue;

      for (const side of ["start", "end"] as const) {
        const spec = (attDoc as { start?: TimeAnchor; end?: TimeAnchor })[side];
        if (!spec || spec.anchor == null) continue;

        const found = findAnchorById(spec.anchor, authored, localTimeline);
        if (!found) continue;
        const anchorRow = rowByIndex.get(found.blockIndex);
        if (anchorRow == null) continue;

        const pointTime = computePointTime(spec, found.doc, found.resolved);
        if (pointTime == null) continue;

        // The line is a plumb line dropped from the anchor point — always
        // vertical at the point's content-x, regardless of where the
        // attachment's resolved edge lands.
        const anchorY0 = yTop(anchorRow);
        const attY0 = yTop(attRow);
        const EXT = 10;
        const ROW_H = 32;
        let anchorOuterY: number;
        let attOuterY: number;
        if (anchorRow < attRow) {
          anchorOuterY = anchorY0 - EXT;
          attOuterY = attY0 + ROW_H + EXT;
        } else if (anchorRow > attRow) {
          anchorOuterY = anchorY0 + ROW_H + EXT;
          attOuterY = attY0 - EXT;
        } else {
          anchorOuterY = anchorY0 + ROW_H / 2;
          attOuterY = anchorOuterY;
        }

        // Source-base/speed mirror what the resolver tracks; clip/audio use
        // the resolved sourceIn + speed, composition uses the doc's `in`.
        let anchorBase = 0;
        let anchorSpeed = 1;
        if (
          found.resolved.type === "clip" ||
          found.resolved.type === "audio"
        ) {
          anchorBase = found.resolved.sourceIn;
          anchorSpeed = found.resolved.speed;
        } else if (found.resolved.type === "composition") {
          anchorBase =
            found.doc.type === "composition" ? found.doc.in ?? 0 : 0;
          anchorSpeed = found.resolved.speed;
        }

        const editCtx: AnchorEditCtx = {
          attIdx,
          side,
          pointTime,
          anchorStart: found.resolved.timelineStart,
          anchorEnd: found.resolved.timelineEnd,
          anchorBase,
          anchorSpeed,
          attNatDur: naturalDurOf(attDoc),
        };

        const lineX = toX(pointTime);
        lines.push({
          key: `${key}-${side}`,
          containerPath: group.path,
          topX: lineX,
          topY: anchorOuterY,
          bottomX: lineX,
          bottomY: attOuterY,
          topLabel: anchorPointKind(spec),
          bottomLabel: offsetKind(spec),
          edit: editCtx,
        });
      }
    }
  }

  if (lines.length === 0) return null;

  const RADIUS = 9;
  const STROKE = "#ffcc00";
  const HIT_THICKNESS = 14;
  const CLICK_THRESHOLD_PX = 4;
  const editable = history != null;

  // Begin a drag (or click+drag from a circle). `kind` selects which field
  // moves; `clickToggle` runs on pointerup if the user never crossed the
  // movement threshold (used for circles, not for line halves).
  //
  // Explicit pointer capture on the originating SVG element keeps the drag
  // alive across the state-driven re-renders each `replace` triggers.
  const startEdit = (
    e: React.PointerEvent,
    containerPath: NodePath,
    ctx: AnchorEditCtx,
    kind: "anchorPoint" | "offset",
    clickToggle: ((spec: TimeAnchor) => TimeAnchor) | null,
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
    const initialAtt = container?.attachments?.[ctx.attIdx];
    if (!initialAtt) return;
    const initialSpec = (initialAtt as {
      start?: TimeAnchor;
      end?: TimeAnchor;
    })[ctx.side];
    if (!initialSpec) return;

    // Commit a new spec for this attachment in its (possibly nested)
    // container — `editContainer` injects the root bin so nested binItems
    // still resolve, then splices the result back at the path.
    const commit = (newSpec: TimeAnchor): SeamFile =>
      editContainer(initialDoc, containerPath, rootBin, (sub) =>
        setAttachmentSpec(sub, ctx.attIdx, ctx.side, newSpec),
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
      const deltaSec = dx / pxPerSec;
      const newSpec =
        kind === "anchorPoint"
          ? dragAnchorPoint(initialSpec, deltaSec, ctx)
          : dragOffset(initialSpec, deltaSec, ctx);
      history.replace(commit(newSpec));
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
        history.push(commit(clickToggle(initialSpec)));
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
                startEdit(e, l.containerPath, l.edit, "anchorPoint", null)
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
                startEdit(e, l.containerPath, l.edit, "offset", null)
              }
            />
            {/* Visible cosmetic line. */}
            <line
              x1={l.topX}
              y1={l.topY}
              x2={l.bottomX}
              y2={l.bottomY}
              stroke={STROKE}
              strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
            {/* Top circle — click to toggle anchorPoint units, drag to move. */}
            <circle
              cx={l.topX}
              cy={l.topY}
              r={RADIUS}
              fill={STROKE}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? "pointer" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.containerPath, l.edit, "anchorPoint", (spec) =>
                  toggleAnchorPoint(spec, l.edit),
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
            {/* Bottom circle — click to toggle offset units, drag to move. */}
            <circle
              cx={l.bottomX}
              cy={l.bottomY}
              r={RADIUS}
              fill={STROKE}
              stroke="#1e1e1e"
              strokeWidth={1}
              style={{
                pointerEvents: editable ? "visiblePainted" : "none",
                cursor: editable ? "pointer" : "default",
              }}
              onPointerDown={(e) =>
                startEdit(e, l.containerPath, l.edit, "offset", (spec) =>
                  toggleOffset(spec, l.edit),
                )
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
              {l.bottomLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
