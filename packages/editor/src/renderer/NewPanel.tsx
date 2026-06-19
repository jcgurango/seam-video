import React, { useState } from "react";
import type { Child } from "@seam/core";
import { SOURCE_DRAG_MIME } from "./useImport.js";

/**
 * "New" accordion section — a palette of node templates the author drags onto
 * the timeline. Each tile carries a prebuilt `Child` in the same
 * `application/x-seam-source` payload the media browser uses, so the timeline's
 * existing drop pipeline (region hit-test → insertion ghost → insert at slot)
 * handles placement identically to dragging in a file. No timeline changes
 * needed — this panel only produces the payload.
 */
interface NewItem {
  label: string;
  icon: string;
  hint: string;
  node: Child;
}

const NEW_ITEMS: NewItem[] = [
  {
    label: "Empty",
    icon: "⬚",
    hint: "A 1s gap / spacer.",
    node: { type: "empty", duration: 1 } as Child,
  },
  {
    label: "Graphic",
    icon: "◆",
    hint: "An animated 2D scene with one empty keyframe.",
    node: { type: "graphic", duration: 1, frames: [[0, []]] } as Child,
  },
  {
    label: "Text",
    icon: "T",
    hint: "A text layer.",
    node: { type: "text", duration: 1, text: "Sample Text" } as Child,
  },
  {
    label: "Data",
    icon: "{ }",
    hint: "A metadata marker (no visuals/audio).",
    node: { type: "data", duration: 1, data: {}, tags: [] } as Child,
  },
];

export default function NewPanel() {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
      <div style={{ color: "#888", fontSize: 11, marginBottom: 10 }}>
        Drag an item onto the timeline to add it.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        {NEW_ITEMS.map((item) => (
          <NewTile key={item.label} item={item} />
        ))}
      </div>
    </div>
  );
}

function NewTile({ item }: { item: NewItem }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      draggable
      title={item.hint}
      onDragStart={(e) => {
        // Same payload shape the media browser emits: a `Child[]` JSON blob the
        // timeline drop handler parses and inserts at the snapped slot.
        e.dataTransfer.setData(SOURCE_DRAG_MIME, JSON.stringify([item.node]));
        e.dataTransfer.effectAllowed = "copy";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "14px 8px",
        background: dragging ? "#2f2f2f" : "#1c1c1c",
        border: "1px solid #333",
        borderRadius: 6,
        cursor: "grab",
        userSelect: "none",
        opacity: dragging ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 22,
          lineHeight: 1,
          color: "#d957b8",
          fontWeight: 600,
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#262026",
          border: "1px solid #3a2f3a",
          borderRadius: 6,
        }}
      >
        {item.icon}
      </span>
      <span style={{ fontSize: 12, color: "#ddd", fontWeight: 600 }}>
        {item.label}
      </span>
    </div>
  );
}
