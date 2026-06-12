// SVG overlay drawn on top of the timeline panel. For every selected
// attachment, draws a labelled line from the anchor point on its
// referenced node to the attachment's resolved edge. When `history`
// is provided (root view), the line is interactive: drag halves
// adjust anchorPoint / offset, click circles toggle units between
// seconds and percent.
//
// Pure dependencies (computePointTime, dragAnchorPoint, etc.) live in
// anchorEdit.ts. Layout primitives (rowYTop, ROW_HEIGHT, ChildBlock)
// live in timelineLayout.ts. This file is the React-side glue.

import React from "react";
import type {
  Child,
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
import { ROW_HEIGHT, rowYTop } from "./timelineLayout.js";
import type { TreeBlock } from "./timelineTree.js";

interface AnchorLineSpec {
  key: string;
  topX: number;
  topY: number;
  bottomX: number;
  bottomY: number;
  topLabel: "s" | "%";
  bottomLabel: "s" | "%";
  edit: AnchorEditCtx;
}

export interface AnchorLinesLayerProps {
  selectedIndices: number[];
  docRoot?: {
    children: Child[];
    attachments?: Child[];
  };
  timeline: ResolvedTimeline;
  /** Root-level blocks (the root group); anchor lines are root-only. */
  blocks: TreeBlock[];
  pxPerSec: number;
  /** Provided only when editing is allowed (root view). */
  history?: History<SeamFile>;
}

export default function AnchorLinesLayer({
  selectedIndices,
  docRoot,
  timeline,
  blocks,
  pxPerSec,
  history,
}: AnchorLinesLayerProps) {
  if (!docRoot) return null;
  const childCount = docRoot.children.length;

  // `blocks` are the root group's blocks; anchor lines are root-only.
  const rowByIndex = new Map<number, number>();
  for (const b of blocks) rowByIndex.set(b.index, b.row);

  const lines: AnchorLineSpec[] = [];

  for (const sel of selectedIndices) {
    if (sel < childCount) continue; // only attachments draw lines
    const j = sel - childCount;
    const attDoc = docRoot.attachments?.[j];
    const attResolved = timeline.children[sel];
    if (!attDoc || !attResolved) continue;
    const attRow = rowByIndex.get(sel);
    if (attRow == null) continue;

    for (const side of ["start", "end"] as const) {
      const spec = (attDoc as { start?: TimeAnchor; end?: TimeAnchor })[side];
      if (!spec || spec.anchor == null) continue;

      const found = findAnchorById(spec.anchor, docRoot, timeline);
      if (!found) continue;
      const anchorRow = rowByIndex.get(found.blockIndex);
      if (anchorRow == null) continue;

      const pointTime = computePointTime(spec, found.doc, found.resolved);
      if (pointTime == null) continue;

      // The line is a plumb line dropped from the anchor point — always
      // perfectly vertical at `pointTime * pxPerSec`, regardless of where
      // the attachment's resolved edge lands. Offset shifts the clip
      // sideways relative to the line, not the line.
      const anchorY0 = rowYTop(anchorRow);
      const attY0 = rowYTop(attRow);
      const EXT = 10;
      let anchorOuterY: number;
      let attOuterY: number;
      if (anchorRow < attRow) {
        anchorOuterY = anchorY0 - EXT;
        attOuterY = attY0 + ROW_HEIGHT + EXT;
      } else if (anchorRow > attRow) {
        anchorOuterY = anchorY0 + ROW_HEIGHT + EXT;
        attOuterY = attY0 - EXT;
      } else {
        anchorOuterY = anchorY0 + ROW_HEIGHT / 2;
        attOuterY = anchorOuterY;
      }

      // Build the per-line edit context. Source-base/speed mirror what
      // `buildIdMapEntry` in the resolver tracks; clip/audio use the
      // resolved sourceIn + speed, composition uses the doc's `in` (the
      // pre-window inner-timeline base) + resolved.speed.
      let anchorBase = 0;
      let anchorSpeed = 1;
      if (
        found.resolved.type === "clip" ||
        found.resolved.type === "audio"
      ) {
        anchorBase = found.resolved.sourceIn;
        anchorSpeed = found.resolved.speed;
      } else if (found.resolved.type === "composition") {
        anchorBase = found.doc.type === "composition" ? found.doc.in ?? 0 : 0;
        anchorSpeed = found.resolved.speed;
      }

      const editCtx: AnchorEditCtx = {
        attIdx: j,
        side,
        pointTime,
        anchorStart: found.resolved.timelineStart,
        anchorEnd: found.resolved.timelineEnd,
        anchorBase,
        anchorSpeed,
        attNatDur: naturalDurOf(attDoc),
      };

      const lineX = pointTime * pxPerSec;
      lines.push({
        key: `${sel}-${side}`,
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
  // We use explicit pointer capture on the originating SVG element so the
  // drag survives state-driven re-renders: each `replace` causes React to
  // reconcile, and without explicit capture the implicit capture browsers
  // do for pointer events can be lost mid-drag — which strands the user
  // with no `pointerup` and the cursor "tied to the mouse".
  const startEdit = (
    e: React.PointerEvent,
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
    const initialAtt = initialDoc.attachments?.[ctx.attIdx];
    if (!initialAtt) return;
    const initialSpec = (initialAtt as {
      start?: TimeAnchor;
      end?: TimeAnchor;
    })[ctx.side];
    if (!initialSpec) return;

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
      const newDoc = setAttachmentSpec(
        initialDoc,
        ctx.attIdx,
        ctx.side,
        newSpec,
      );
      history.replace(newDoc);
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
        const newSpec = clickToggle(initialSpec);
        const newDoc = setAttachmentSpec(
          initialDoc,
          ctx.attIdx,
          ctx.side,
          newSpec,
        );
        history.push(newDoc);
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
              onPointerDown={(e) => startEdit(e, l.edit, "anchorPoint", null)}
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
              onPointerDown={(e) => startEdit(e, l.edit, "offset", null)}
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
                startEdit(e, l.edit, "anchorPoint", (spec) =>
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
                startEdit(e, l.edit, "offset", (spec) =>
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
