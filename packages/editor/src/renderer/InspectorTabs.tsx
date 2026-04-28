import React, { useState } from "react";
import { useTimeline } from "@seam/preview";
import type { Child, ResolvedChild, ResolvedTimeline, SeamFile } from "@seam/core";
import JsonNodePanel from "./JsonNodePanel.js";

type TabId = "properties" | "filters" | "json" | "script" | "inspector";

const TABS: { id: TabId; label: string }[] = [
  { id: "properties", label: "Properties" },
  { id: "filters", label: "Filters" },
  { id: "json", label: "JSON" },
  { id: "script", label: "Script" },
  { id: "inspector", label: "Inspector" },
];

interface InspectorTabsProps {
  timeline: ResolvedTimeline | null;
  viewDocument: SeamFile;
  /** The JSON node currently in focus (whole doc at root, or a child for nested views). */
  jsonNode: unknown;
  /** Validate + commit a new value for the JSON node. Returns errors or null. */
  onJsonNodeSave: (next: unknown) => string[] | null;
  /** Path key inside `jsonNode` to reveal in the JSON editor (e.g. "children.3"). */
  jsonJumpPath: string | null;
}

export default function InspectorTabs({
  timeline,
  viewDocument,
  jsonNode,
  onJsonNodeSave,
  jsonJumpPath,
}: InspectorTabsProps) {
  const [active, setActive] = useState<TabId>("properties");

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        background: "#222",
        borderRight: "1px solid #333",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          borderBottom: "1px solid #333",
          background: "#1f1f1f",
        }}
      >
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              style={{
                background: isActive ? "#2a2a2a" : "transparent",
                border: "none",
                borderRight: "1px solid #333",
                borderBottom: isActive
                  ? "2px solid #4a7eb8"
                  : "2px solid transparent",
                color: isActive ? "#fff" : "#aaa",
                padding: "8px 14px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          fontSize: 12,
          color: "#ccc",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {active === "properties" && (
          <PaddedTab>Properties panel (placeholder)</PaddedTab>
        )}
        {active === "filters" && (
          <PaddedTab>Filters panel (placeholder)</PaddedTab>
        )}
        {active === "json" && (
          <JsonNodePanel
            node={jsonNode}
            onSave={onJsonNodeSave}
            jumpPath={jsonJumpPath}
          />
        )}
        {active === "script" && (
          <PaddedTab>Script panel (placeholder)</PaddedTab>
        )}
        {active === "inspector" && (
          <PaddedTab>
            <InspectorPanel timeline={timeline} viewDocument={viewDocument} />
          </PaddedTab>
        )}
      </div>
    </div>
  );
}

function PaddedTab({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
      {children}
    </div>
  );
}

function formatTime(s: number): string {
  return `${s.toFixed(3)}s`;
}

function nodeLabel(child: ResolvedChild): string {
  if (child.type === "clip" || child.type === "audio") {
    return (child.source ?? "").split("/").pop() || child.type;
  }
  return child.type;
}

function InspectorPanel({
  timeline,
  viewDocument,
}: {
  timeline: ResolvedTimeline | null;
  viewDocument: SeamFile;
}) {
  const { currentTime } = useTimeline();

  if (!timeline) {
    return <div style={{ color: "#888" }}>No timeline.</div>;
  }

  const attachmentStartIndex = viewDocument.children.length;
  const docChildren = viewDocument.children;
  const docAttachments = viewDocument.attachments ?? [];

  const covering = timeline.children
    .map((child, index) => ({ child, index }))
    .filter(
      ({ child }) =>
        currentTime >= child.timelineStart && currentTime < child.timelineEnd
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row label="Playhead" value={formatTime(currentTime)} />

      {covering.length === 0 ? (
        <div style={{ color: "#888", fontStyle: "italic" }}>
          (no children at playhead)
        </div>
      ) : (
        covering.map(({ child, index }) => {
          const isAttachment = index >= attachmentStartIndex;
          const docChild: Child | undefined = isAttachment
            ? docAttachments[index - attachmentStartIndex]
            : docChildren[index];
          return (
            <NodeBlock
              key={index}
              child={child}
              docChild={docChild}
              currentTime={currentTime}
              isAttachment={isAttachment}
            />
          );
        })
      )}
    </div>
  );
}

function NodeBlock({
  child,
  docChild,
  currentTime,
  isAttachment,
}: {
  child: ResolvedChild;
  docChild: Child | undefined;
  currentTime: number;
  isAttachment: boolean;
}) {
  const localTime = currentTime - child.timelineStart;
  const outputDuration = child.timelineEnd - child.timelineStart;

  const hasSource = child.type === "clip" || child.type === "audio";
  const sourceTime = hasSource
    ? child.sourceIn + localTime * child.speed
    : null;
  const sourceSpan = hasSource ? child.sourceOut - child.sourceIn : 0;
  const sourcePct =
    hasSource && sourceSpan > 0
      ? ((sourceTime! - child.sourceIn) / sourceSpan) * 100
      : null;

  return (
    <div
      style={{
        border: "1px solid #333",
        borderRadius: 4,
        padding: 10,
        background: "#1c1c1c",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          fontWeight: 600,
          color: "#fff",
        }}
      >
        <span>
          {nodeLabel(child)}
          {docChild && "id" in docChild && docChild.id ? (
            <span style={{ color: "#888", fontWeight: 400, marginLeft: 6 }}>
              ({docChild.id})
            </span>
          ) : null}
        </span>
        <span
          style={{
            fontSize: 10,
            color: "#888",
            fontWeight: 400,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {isAttachment ? "attachment" : child.type}
        </span>
      </div>
      <Row label="On node" value={formatTime(localTime)} />
      {hasSource ? (
        <>
          <Row label="Source" value={formatTime(sourceTime!)} />
          <Row
            label="Source %"
            value={sourcePct != null ? `${sourcePct.toFixed(2)}%` : "—"}
          />
        </>
      ) : (
        <Row
          label="Node %"
          value={
            outputDuration > 0
              ? `${((localTime / outputDuration) * 100).toFixed(2)}%`
              : "—"
          }
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "2px 0",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ color: "#888" }}>{label}</span>
      <span style={{ color: "#ddd" }}>{value}</span>
    </div>
  );
}
