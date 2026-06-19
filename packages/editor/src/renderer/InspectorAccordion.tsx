import React, { useEffect, useState } from "react";
import { useTimeline } from "@seam/preview";
import type {
  BinEntry,
  Child,
  Composition,
  ResolvedChild,
  ResolvedTimeline,
  SeamFile,
} from "@seam/core";
import JsonNodePanel from "./JsonNodePanel.js";
import ScriptPanel from "./ScriptPanel.js";
import BinPanel from "./BinPanel.js";
import MediaBrowser from "./MediaBrowser.js";
import NewPanel from "./NewPanel.js";
import { findBinItem } from "./nodeBin.js";
import type { Platform } from "./platform/index.js";
import type { WebPlatform } from "./platform/web.js";

type SectionId =
  | "new"
  | "properties"
  | "filters"
  | "json"
  | "script"
  | "inspector"
  | "bin"
  | "media";

const BASE_SECTIONS: { id: SectionId; label: string }[] = [
  { id: "new", label: "New" },
  { id: "properties", label: "Properties" },
  { id: "filters", label: "Filters" },
  { id: "json", label: "JSON" },
  { id: "script", label: "Script" },
  { id: "inspector", label: "Inspector" },
  { id: "bin", label: "Bin" },
];
// The media browser is OPFS-backed, so web-only.
const WEB_SECTIONS: { id: SectionId; label: string }[] = [
  { id: "media", label: "Media" },
];

interface InspectorAccordionProps {
  timeline: ResolvedTimeline | null;
  document: SeamFile;
  /** The JSON node currently in focus (whole doc at root, or a child for nested views). */
  jsonNode: unknown;
  /** Validate + commit a new value for the JSON node. Returns errors or null. */
  onJsonNodeSave: (next: unknown) => string[] | null;
  /** Path key inside `jsonNode` to reveal in the JSON editor (e.g. "children.3"). */
  jsonJumpPath: string | null;
  /** Bumped each time a keyframe diamond is clicked — forces the JSON
   *  section open so the deep keyframe path can be revealed. */
  jsonRevealToken?: number;
  /** The composition the Script section targets — null in clip view. */
  scriptComposition: Composition | null;
  /** Last script-execution error from the active composition (or null). */
  scriptError: string | null;
  /** Apply a transformed composition produced by the Script section. */
  onScriptApply: (next: Composition) => string[] | null;
  /** Editor-surface root, used by the Bin section to read + rewrite entries. */
  rootDocument: SeamFile;
  /** Push a new editor-surface root back to history (typically the same
   *  callback used by ControlsBar/TimelinePanel). */
  onRootDocumentChange: (next: SeamFile) => void;
  /** Enter CC Cut view for the given bin entry. */
  onEnterCCCut: (binId: string) => void;
  /** Platform — gates the web-only Media section + backs its browser. */
  platform: Platform;
}

/**
 * Left-pane accordion. Unlike the old tab strip, any number of sections
 * can be expanded at once; each expanded section gets an equal share of
 * the available height (the panels that need room — Inspector, Bin, JSON
 * — manage their own internal overflow).
 */
export default function InspectorAccordion({
  timeline,
  document,
  jsonNode,
  onJsonNodeSave,
  jsonJumpPath,
  jsonRevealToken,
  scriptComposition,
  scriptError,
  onScriptApply,
  rootDocument,
  onRootDocumentChange,
  onEnterCCCut,
  platform,
}: InspectorAccordionProps) {
  const sections =
    platform.kind === "web" ? [...BASE_SECTIONS, ...WEB_SECTIONS] : BASE_SECTIONS;
  const [open, setOpen] = useState<Set<SectionId>>(
    () => new Set<SectionId>(["new"]),
  );

  const toggle = (id: SectionId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A keyframe diamond click bumps `jsonRevealToken` — open the JSON section
  // (if collapsed) so JsonNodePanel mounts and reveals the keyframe path.
  useEffect(() => {
    if (!jsonRevealToken) return;
    setOpen((prev) => (prev.has("json") ? prev : new Set(prev).add("json")));
  }, [jsonRevealToken]);

  const renderContent = (id: SectionId): React.ReactNode => {
    switch (id) {
      case "new":
        return <NewPanel />;
      case "properties":
        return <PaddedTab>Properties panel (placeholder)</PaddedTab>;
      case "filters":
        return <PaddedTab>Filters panel (placeholder)</PaddedTab>;
      case "json":
        return (
          <JsonNodePanel
            node={jsonNode}
            onSave={onJsonNodeSave}
            jumpPath={jsonJumpPath}
          />
        );
      case "script":
        return (
          <ScriptPanel
            currentComposition={scriptComposition}
            scriptError={scriptError}
            onApply={onScriptApply}
          />
        );
      case "inspector":
        return (
          <PaddedTab>
            <InspectorPanel timeline={timeline} viewDocument={document} />
          </PaddedTab>
        );
      case "bin":
        return (
          <BinPanel
            rootDocument={rootDocument}
            onRootDocumentChange={onRootDocumentChange}
            onEnterCCCut={onEnterCCCut}
          />
        );
      case "media":
        return (
          <MediaBrowser
            platform={platform as WebPlatform}
            currentDoc={document}
          />
        );
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        background: "#222",
      }}
    >
      {sections.map((section) => {
        const isOpen = open.has(section.id);
        return (
          <div
            key={section.id}
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              // Open sections share the leftover height equally; collapsed
              // ones shrink to just their header.
              flex: isOpen ? "1 1 0" : "0 0 auto",
              borderBottom: "1px solid #333",
            }}
          >
            <button
              onClick={() => toggle(section.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: isOpen ? "#2a2a2a" : "#1f1f1f",
                border: "none",
                borderLeft: isOpen
                  ? "2px solid #4a7eb8"
                  : "2px solid transparent",
                color: isOpen ? "#fff" : "#aaa",
                padding: "8px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
                flexShrink: 0,
              }}
            >
              <span style={{ width: 10, color: "#888", fontSize: 10 }}>
                {isOpen ? "▾" : "▸"}
              </span>
              {section.label}
            </button>
            {/* Content is unmounted while collapsed — only the header renders.
                Heavy panels (Monaco JSON/Script editors, Bin map previews)
                otherwise keep doing per-mutation work (re-tokenize, re-feed)
                while hidden, which stalls large documents. The tradeoff is
                that panel state (editor buffer/undo, scroll, map instances)
                resets when a section is reopened. */}
            {isOpen && (
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
                {renderContent(section.id)}
              </div>
            )}
          </div>
        );
      })}
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

  const blocks = renderCoveringBlocks({
    resolved: timeline,
    docComp: viewDocument,
    currentTime,
    depth: 0,
    keyPath: "",
    rootBin: (viewDocument as Composition).bin ?? [],
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row label="Playhead" value={formatTime(currentTime)} />

      {blocks.length === 0 ? (
        <div style={{ color: "#888", fontStyle: "italic" }}>
          (no children at playhead)
        </div>
      ) : (
        blocks
      )}
    </div>
  );
}

/** Walk one composition level, render NodeBlocks for every resolved
 *  child the playhead is inside, and recurse into compositions. The
 *  resolver keeps each composition's children in that composition's
 *  own post-window output coords (starting at 0), so descending one
 *  level is just `currentTime − parentChild.timelineStart`. */
function renderCoveringBlocks({
  resolved,
  docComp,
  currentTime,
  depth,
  keyPath,
  rootBin,
}: {
  resolved: { children: ResolvedChild[] };
  docComp: { children: Child[]; attachments?: Child[] };
  currentTime: number;
  depth: number;
  /** Path of indices from the root, so keys stay unique across sibling
   *  composition subtrees (two refs to the same bin entry would otherwise
   *  both produce e.g. `1-1`). */
  keyPath: string;
  /** Root bin entries, for descending into `binItem` references (whose own
   *  `children` are empty — the body lives in the shared bin entry). */
  rootBin: BinEntry[];
}): React.ReactNode[] {
  const attachmentStartIndex = docComp.children.length;
  const docChildren = docComp.children;
  const docAttachments = docComp.attachments ?? [];

  const out: React.ReactNode[] = [];
  resolved.children.forEach((child, index) => {
    if (
      currentTime < child.timelineStart ||
      currentTime >= child.timelineEnd
    ) {
      return;
    }
    const isAttachment = index >= attachmentStartIndex;
    const docChild: Child | undefined = isAttachment
      ? docAttachments[index - attachmentStartIndex]
      : docChildren[index];
    const key = `${keyPath}${index}`;
    out.push(
      <NodeBlock
        key={key}
        child={child}
        docChild={docChild}
        currentTime={currentTime}
        isAttachment={isAttachment}
        depth={depth}
      />,
    );
    if (child.type === "composition" && docChild?.type === "composition") {
      // A `binItem` reference's own children are empty — the resolved
      // children come from the shared bin entry, so descend into that
      // entry's body (mirrors the timeline's `layoutTree`). Regular
      // compositions descend into their own body.
      const binId = docChild.binItem;
      const subComp: { children: Child[]; attachments?: Child[] } = binId
        ? findBinItem(rootBin, binId) ?? { children: [] }
        : docChild;
      out.push(
        ...renderCoveringBlocks({
          resolved: child,
          docComp: subComp,
          currentTime: currentTime - child.timelineStart,
          depth: depth + 1,
          keyPath: `${key}/`,
          rootBin,
        }),
      );
    }
  });
  return out;
}

function NodeBlock({
  child,
  docChild,
  currentTime,
  isAttachment,
  depth,
}: {
  child: ResolvedChild;
  docChild: Child | undefined;
  currentTime: number;
  isAttachment: boolean;
  depth: number;
}) {
  const localTime = currentTime - child.timelineStart;
  const outputDuration = child.timelineEnd - child.timelineStart;

  // Derive the "source" coordinates for nodes that have an inner
  // timeline: clip/audio (the underlying media), and composition (its
  // inner — pre-window — timeline). For compositions the bounds come
  // from the doc-side `in`/`out` (defaulted to 0..naturalInner) since
  // the resolver doesn't carry them on `ResolvedComposition`.
  let sourceIn: number | null = null;
  let sourceOut: number | null = null;
  let sourceTime: number | null = null;
  if (child.type === "clip" || child.type === "audio") {
    sourceIn = child.sourceIn;
    sourceOut = child.sourceOut;
    sourceTime = sourceIn + localTime * child.speed;
  } else if (child.type === "composition" && docChild?.type === "composition") {
    sourceIn = docChild.in ?? 0;
    // out unset → window spans the full inner timeline; reconstruct
    // its length from the resolved output: innerLen = outputLen * speed.
    sourceOut = docChild.out ?? sourceIn + child.duration * child.speed;
    sourceTime = sourceIn + localTime * child.speed;
  }
  const hasSource = sourceTime != null && sourceIn != null && sourceOut != null;
  const sourceSpan = hasSource ? sourceOut! - sourceIn! : 0;
  const sourcePct =
    hasSource && sourceSpan > 0
      ? ((sourceTime! - sourceIn!) / sourceSpan) * 100
      : null;

  return (
    <div
      style={{
        border: "1px solid #333",
        borderRadius: 4,
        padding: 10,
        background: "#1c1c1c",
        marginLeft: depth * 16,
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
      {/* Effective (post-resolution) source trim — the resolver crops these
          to whatever a composition window / overflow actually leaves, so they
          can differ from the authored `in`/`out`. Graphics have no source
          trim, so their "after resolution" value is the output duration. */}
      {child.type === "clip" || child.type === "audio" ? (
        <Row
          label="Effective in/out"
          value={`${formatTime(child.sourceIn)} – ${formatTime(child.sourceOut)}`}
        />
      ) : null}
      {child.type === "graphic" ? (
        <Row label="Effective duration" value={formatTime(outputDuration)} />
      ) : null}
      {child.type === "graphic" ? <GraphicReadOnlySummary child={child} /> : null}
    </div>
  );
}

function GraphicReadOnlySummary({
  child,
}: {
  child: import("@seam/core").ResolvedGraphic;
}) {
  const frameCount = child.frames.length;
  const clipCount = child.clips?.length ?? 0;
  const cw = typeof child.contentWidth === "number" ? child.contentWidth : "auto";
  const ch = typeof child.contentHeight === "number" ? child.contentHeight : "auto";
  const dur = typeof child.duration === "number" ? `${child.duration}s` : "auto";
  // Collect distinct Map sources for at-a-glance overview.
  const mapSources = new Set<string>();
  for (const f of child.frames) {
    walkObjs(f[1] as ReadonlyArray<unknown>, (o) => {
      if (
        o.type === "Map" &&
        typeof o.source === "string"
      ) {
        mapSources.add(o.source);
      }
    });
  }
  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px dashed #333",
        color: "#bbb",
      }}
    >
      <div style={{ color: "#888", fontSize: 10, marginBottom: 4 }}>
        GRAPHIC (read-only)
      </div>
      <Row label="Duration" value={dur} />
      <Row label="Content" value={`${cw} × ${ch}`} />
      <Row label="Frames" value={String(frameCount)} />
      <Row label="Clips" value={String(clipCount)} />
      <Row label="Loop" value={child.loop ? "true" : "false"} />
      {mapSources.size > 0 ? (
        <Row label="Maps" value={[...mapSources].join(", ")} />
      ) : null}
    </div>
  );
}

function walkObjs(
  arr: ReadonlyArray<unknown>,
  visit: (o: Record<string, unknown>) => void,
): void {
  for (const o of arr) {
    if (o && typeof o === "object") {
      visit(o as Record<string, unknown>);
      const inner = (o as Record<string, unknown>).objects;
      if (Array.isArray(inner)) walkObjs(inner, visit);
    }
  }
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
