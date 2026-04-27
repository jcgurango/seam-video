import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type {
  SeamFile,
  Child,
  Composition,
  TimeAnchor,
} from "@seam/core";
import {
  Play,
  Pause,
  SkipBack,
  Repeat,
  Scissors,
  FolderOpen,
  Trash2,
  Undo2,
  Redo2,
  ArrowLeft,
  LogIn,
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { Platform } from "./platform/index.js";

interface ControlsBarProps {
  document: SeamFile;
  filePath: string | null;
  selectedIndices: number[];
  onSelectionChange: (indices: number[]) => void;
  onDocumentChange: (doc: SeamFile) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  view: View;
  platform: Platform;
  onExit: (viewTime: number) => void;
  onEnterClip: (rootIndex: number, currentParentTime: number) => void;
}

// ── Slice logic ──────────────────────────────────────────────────────

function clipBaseSpeed(clip: {
  in: number;
  out: number;
  speed?: number;
  duration?: number;
}): number {
  if (clip.duration != null) return (clip.out - clip.in) / clip.duration;
  return clip.speed ?? 1;
}

/** Collect every `id` appearing anywhere in the document tree. */
function collectAllIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (child: Child) => {
    const id = (child as { id?: string }).id;
    if (id != null) out.add(id);
    if (child.type === "composition") {
      child.children.forEach(visit);
      if (child.attachments) child.attachments.forEach(visit);
    }
  };
  visit(doc);
  return out;
}

/**
 * Pick a unique id for the right-hand side of a split, starting from
 * `${origId}_split` and suffixing `_2`, `_3`, ... on collision.
 */
function uniqueSplitId(existingIds: Set<string>, origId: string): string {
  const base = `${origId}_split`;
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

// ── Anchor rewrite after split ───────────────────────────────────────

/**
 * Context needed to rewrite an anchor that points at a node which just got
 * split in half. All time values are in the ORIGINAL target's local output
 * timeline (the pre-split node's timelineStart-origin coords).
 */
interface SplitContext {
  origId: string;
  rightId: string;
  splitOffset: number; // split point, target-local output seconds
  origLen: number;     // original target's output duration
  baseSourceTime: number; // for source-mode: clip.in
  speed: number;       // for source-mode: source-secs-per-output-sec at the target level
}

function parsePercentStr(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]) / 100 : 0;
}

function formatPercentStr(fraction: number): string {
  return `${Math.round(fraction * 1000000) / 10000}%`;
}

/** Natural output duration of a node — used by the anchor rewriter to expand
 *  %-offsets, which are sized against the *attachment's own length*. */
function nodeNaturalDuration(node: Child): number {
  if (node.type === "clip" || node.type === "audio") {
    if (node.duration != null) return node.duration;
    const speed = node.speed ?? 1;
    return (node.out - node.in) / speed;
  }
  if (node.type === "empty") return node.duration;
  if (node.type === "data") return node.duration ?? 0;
  if (node.type === "composition") {
    if (node.in != null && node.out != null) return node.out - node.in;
    try {
      return resolveComposition(node).duration;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Rewrite a single anchor spec so it still resolves to the same absolute
 * output time, pointing at whichever half of the split contains it.
 * Returns the original spec if it doesn't reference `origId`.
 */
function rewriteAnchor(
  spec: TimeAnchor | undefined,
  ctx: SplitContext,
  attachmentNatDur: number
): TimeAnchor | undefined {
  if (!spec || spec.anchor !== ctx.origId) return spec;

  let offsetSeconds = 0;
  if (spec.offset != null) {
    offsetSeconds =
      typeof spec.offset === "number"
        ? spec.offset
        : parsePercentStr(spec.offset) * attachmentNatDur;
  }

  let pointOnTarget: number;
  if (spec.timeSource === "source") {
    const sourceTime =
      typeof spec.anchorPoint === "number" ? spec.anchorPoint : 0;
    pointOnTarget = (sourceTime - ctx.baseSourceTime) / ctx.speed;
  } else {
    const pct =
      typeof spec.anchorPoint === "string"
        ? parsePercentStr(spec.anchorPoint)
        : 0;
    pointOnTarget = pct * ctx.origLen;
  }

  const targetLocalTime = pointOnTarget + offsetSeconds;
  const onLeft = targetLocalTime <= ctx.splitOffset;
  const newAnchorId = onLeft ? ctx.origId : ctx.rightId;

  if (spec.timeSource === "source") {
    const rewritten: TimeAnchor = {
      anchor: newAnchorId,
      timeSource: "source",
      anchorPoint: spec.anchorPoint,
    };
    if (spec.offset != null) rewritten.offset = spec.offset;
    return rewritten;
  }

  const leftLen = ctx.splitOffset;
  const rightLen = ctx.origLen - ctx.splitOffset;
  const newLen = onLeft ? leftLen : rightLen;
  const localOnNew = onLeft
    ? targetLocalTime
    : targetLocalTime - ctx.splitOffset;
  const newFraction = newLen !== 0 ? localOnNew / newLen : 0;
  return {
    anchor: newAnchorId,
    timeSource: "output",
    anchorPoint: formatPercentStr(newFraction),
  };
}

/** Recursively rewrite all `start`/`end` anchors in the tree. */
function rewriteAnchorsInNode(node: Child, ctx: SplitContext): Child {
  const natDur = nodeNaturalDuration(node);
  let next: Child = node;
  const newStart = rewriteAnchor(node.start, ctx, natDur);
  const newEnd = rewriteAnchor(node.end, ctx, natDur);
  if (newStart !== node.start || newEnd !== node.end) {
    next = { ...node };
    if (newStart !== undefined) next.start = newStart;
    if (newEnd !== undefined) next.end = newEnd;
  }

  if (next.type === "composition") {
    const rewrittenChildren = next.children.map((c) =>
      rewriteAnchorsInNode(c, ctx)
    );
    const rewrittenAttachments = next.attachments?.map((c) =>
      rewriteAnchorsInNode(c, ctx)
    );
    const updated: Composition = { ...next, children: rewrittenChildren };
    if (rewrittenAttachments) updated.attachments = rewrittenAttachments;
    return updated;
  }
  return next;
}

function rewriteSplitAnchors(doc: SeamFile, ctx: SplitContext): SeamFile {
  return rewriteAnchorsInNode(doc, ctx) as SeamFile;
}

function sliceAtPlayhead(doc: SeamFile, currentTime: number): SeamFile | null {
  const resolved = resolveComposition(doc);
  const children = doc.children;

  let targetIdx = -1;
  let timelineStart = 0;

  for (let i = 0; i < resolved.children.length; i++) {
    const rc = resolved.children[i];
    if (currentTime > rc.timelineStart && currentTime < rc.timelineEnd) {
      targetIdx = i;
      timelineStart = rc.timelineStart;
      break;
    }
  }

  if (targetIdx === -1) return null;

  const child = children[targetIdx];
  // Splitting is only defined for clip/audio for now. Composition splitting
  // used to lean on refs (the .seam concept that's gone) — we'll figure out
  // its UX once references re-emerge as an editor concept.
  if (child.type !== "clip" && child.type !== "audio") return null;

  const offset = currentTime - timelineStart;
  const origLen =
    resolved.children[targetIdx].timelineEnd -
    resolved.children[targetIdx].timelineStart;
  const newChildren = [...children];

  // Both halves of a split can't share the original id — left keeps it,
  // right gets a generated `${id}_split` variant (de-duplicated against
  // everything else already in the document).
  const existingIds = collectAllIds(doc);
  const origId = (child as { id?: string }).id;
  const rightId = origId != null ? uniqueSplitId(existingIds, origId) : undefined;
  const applyAnchorRewrite = (nextDoc: SeamFile): SeamFile => {
    if (origId == null || rightId == null) return nextDoc;
    const ctx: SplitContext = {
      origId,
      rightId,
      splitOffset: offset,
      origLen,
      baseSourceTime: child.in,
      speed: clipBaseSpeed(child),
    };
    return rewriteSplitAnchors(nextDoc, ctx);
  };

  const speed = clipBaseSpeed(child);
  const splitSource = child.in + offset * speed;
  const { duration: _d, ...base } = child;
  const first = { ...base, out: splitSource } as typeof child;
  const second = { ...base, in: splitSource } as typeof child;
  if (rightId != null) second.id = rightId;
  else delete (second as { id?: string }).id;
  newChildren.splice(targetIdx, 1, first, second);
  return applyAnchorRewrite({ ...doc, children: newChildren });
}

// ── Styles ───────────────────────────────────────────────────────────

const BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "8px 16px",
  background: "#2a2a2a",
  borderTop: "1px solid #333",
};

const BTN_STYLE: React.CSSProperties = {
  background: "none",
  border: "1px solid #555",
  color: "#fff",
  borderRadius: 6,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  flexShrink: 0,
};

const BTN_ACTIVE: React.CSSProperties = {
  ...BTN_STYLE,
  background: "#4a9eff",
  borderColor: "#4a9eff",
};

const SEPARATOR: React.CSSProperties = {
  width: 1,
  height: 28,
  background: "#444",
  margin: "0 8px",
  flexShrink: 0,
};

const TIME_STYLE: React.CSSProperties = {
  color: "#999",
  fontSize: 13,
  fontFamily: "monospace",
  minWidth: 110,
  textAlign: "center",
  flexShrink: 0,
};

const ICON_SIZE = 16;

// ── Component ────────────────────────────────────────────────────────

export default function ControlsBar({
  document: doc,
  filePath,
  selectedIndices,
  onSelectionChange,
  onDocumentChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  view,
  onExit,
  onEnterClip,
  platform,
}: ControlsBarProps) {
  const {
    currentTime,
    totalDuration,
    isPlaying,
    loop,
    play,
    pause,
    restart,
    seek,
    setLoop,
  } = useTimeline();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFiles = useImport(doc, filePath, onDocumentChange, platform);

  // ── Slice ──────────────────────────────────────────────────────

  const handleSlice = useCallback(() => {
    const nextDoc = sliceAtPlayhead(doc, currentTime);
    if (nextDoc) onDocumentChange(nextDoc);
  }, [doc, currentTime, onDocumentChange]);

  // S key shortcut (disabled in non-root views)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view.type !== "root") return;
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        handleSlice();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSlice, view]);

  // Escape to exit a nested view
  useEffect(() => {
    if (view.type === "root") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit(currentTime);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, currentTime, onExit]);

  // ── Import ─────────────────────────────────────────────────────

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        importFiles(e.target.files);
        e.target.value = "";
      }
    },
    [importFiles]
  );

  // ── Scrub bar ──────────────────────────────────────────────────

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(pct * totalDuration);
  };

  // Slice is only enabled when at least one selected (or playhead-targeted)
  // child is a clip or audio node.
  const canSlice = selectedIndices.length === 0
    ? doc.children.some((c) => c.type === "clip" || c.type === "audio")
    : selectedIndices.some((i) => {
        const t = doc.children[i]?.type;
        return t === "clip" || t === "audio";
      });

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div>
      {/* Scrub bar */}
      <div
        onClick={handleScrub}
        style={{
          height: 4,
          background: "#444",
          cursor: "pointer",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            height: "100%",
            width: `${progress}%`,
            background: "#4a9eff",
          }}
        />
      </div>

      {/* Button bar */}
      <div style={BAR_STYLE}>
        {/* Transport */}
        <button
          onClick={isPlaying ? pause : play}
          style={BTN_STYLE}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={ICON_SIZE} /> : <Play size={ICON_SIZE} />}
        </button>
        <button onClick={restart} style={BTN_STYLE} title="Restart">
          <SkipBack size={ICON_SIZE} />
        </button>
        <button
          onClick={() => setLoop(!loop)}
          style={loop ? BTN_ACTIVE : BTN_STYLE}
          title="Loop"
        >
          <Repeat size={ICON_SIZE} />
        </button>

        {/* Time display */}
        <span style={TIME_STYLE}>
          {currentTime.toFixed(1)}s / {totalDuration.toFixed(1)}s
        </span>

        <div style={SEPARATOR} />

        {/* Undo / Redo */}
        <button
          onClick={onUndo}
          style={{ ...BTN_STYLE, opacity: canUndo ? 1 : 0.3 }}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={ICON_SIZE} />
        </button>
        <button
          onClick={onRedo}
          style={{ ...BTN_STYLE, opacity: canRedo ? 1 : 0.3 }}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={ICON_SIZE} />
        </button>

        <div style={SEPARATOR} />

        {/* Edit tools */}
        {view.type === "root" ? (
          <>
            <button onClick={handleImportClick} style={BTN_STYLE} title="Import">
              <FolderOpen size={ICON_SIZE} />
            </button>
            <button
              onClick={handleSlice}
              style={{ ...BTN_STYLE, opacity: canSlice ? 1 : 0.3 }}
              disabled={!canSlice}
              title="Slice (S) — clip and audio only"
            >
              <Scissors size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                const enterableIdx = [...selectedIndices]
                  .sort((a, b) => a - b)
                  .find((i) => {
                    const t = doc.children[i]?.type;
                    return t === "clip" || t === "composition";
                  });
                if (enterableIdx != null) onEnterClip(enterableIdx, currentTime);
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndices.some((i) => {
                  const t = doc.children[i]?.type;
                  return t === "clip" || t === "composition";
                })
                  ? 1
                  : 0.3,
              }}
              disabled={
                !selectedIndices.some((i) => {
                  const t = doc.children[i]?.type;
                  return t === "clip" || t === "composition";
                })
              }
              title="Enter (double-click)"
            >
              <LogIn size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                if (selectedIndices.length > 0) {
                  const sortedDesc = [...selectedIndices].sort((a, b) => b - a);
                  const newChildren = [...doc.children];
                  for (const i of sortedDesc) newChildren.splice(i, 1);
                  onDocumentChange({ ...doc, children: newChildren });
                  onSelectionChange([]);
                }
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndices.length > 0 ? 1 : 0.3,
              }}
              disabled={selectedIndices.length === 0}
              title="Delete (Del)"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </>
        ) : (
          <button
            onClick={() => onExit(currentTime)}
            style={BTN_STYLE}
            title="Back (Esc)"
          >
            <ArrowLeft size={ICON_SIZE} />
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          onChange={handleFileInput}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
