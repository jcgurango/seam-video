import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type {
  SeamFile,
  Clip,
  Child,
  RefChild,
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

/** Pick a ref name not yet used in the given refs dict. */
function uniqueRefName(refs: Record<string, Child> | undefined, base: string): string {
  if (!refs) return `${base}_1`;
  let i = 1;
  while (refs[`${base}_${i}`] != null) i++;
  return `${base}_${i}`;
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
      if (child.refs) Object.values(child.refs).forEach(visit);
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
  baseSourceTime: number; // for source-mode: the node's pre-trim base (clip.in or composition.in)
  speed: number;       // for source-mode: source-secs-per-output-sec at the target level
}

function parsePercentStr(s: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? parseFloat(m[1]) / 100 : 0;
}

function formatPercentStr(fraction: number): string {
  return `${Math.round(fraction * 1000000) / 10000}%`;
}

/**
 * Rewrite a single anchor spec so it still resolves to the same absolute
 * output time, pointing at whichever half of the split contains it.
 * Returns the original spec if it doesn't reference `origId`.
 */
function rewriteAnchor(
  spec: TimeAnchor | undefined,
  ctx: SplitContext
): TimeAnchor | undefined {
  if (!spec || spec.anchor !== ctx.origId) return spec;

  // offset in absolute output seconds (regardless of number / % form)
  let offsetSeconds = 0;
  if (spec.offset != null) {
    offsetSeconds =
      typeof spec.offset === "number"
        ? spec.offset
        : parsePercentStr(spec.offset) * ctx.origLen;
  }

  // anchorPoint in target-local output seconds (pre-offset)
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
    // Source time is absolute in the underlying media; the same `anchorPoint`
    // still maps correctly from either half because each half's baseSourceTime
    // and timelineStart shift together. Fold any %-offset into seconds so its
    // meaning doesn't silently depend on the new half's length.
    const rewritten: TimeAnchor = {
      anchor: newAnchorId,
      timeSource: "source",
      anchorPoint: spec.anchorPoint,
    };
    if (offsetSeconds !== 0) rewritten.offset = offsetSeconds;
    return rewritten;
  }

  // Output mode: recompute the percentage relative to the new half's length
  // and fold the offset into the point, dropping the separate offset field.
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
  let next: Child = node;
  const newStart = rewriteAnchor(node.start, ctx);
  const newEnd = rewriteAnchor(node.end, ctx);
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
    const rewrittenRefs = next.refs
      ? Object.fromEntries(
          Object.entries(next.refs).map(([k, v]) => [
            k,
            rewriteAnchorsInNode(v, ctx),
          ])
        )
      : undefined;
    const updated: Composition = { ...next, children: rewrittenChildren };
    if (rewrittenAttachments) updated.attachments = rewrittenAttachments;
    if (rewrittenRefs) updated.refs = rewrittenRefs;
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
  if (child.type === "empty") return null;

  const offset = currentTime - timelineStart;
  const origLen =
    resolved.children[targetIdx].timelineEnd -
    resolved.children[targetIdx].timelineStart;
  const newChildren = [...children];

  // Both halves of a split can't share the original id — left keeps it,
  // right gets a generated `${id}_split` variant (de-duplicated against
  // everything else already in the document). When there's an id, any
  // anchor elsewhere in the doc that points at it gets re-routed to the
  // correct half so it still resolves to the same absolute output time.
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
      baseSourceTime:
        child.type === "clip" ? child.in : (child as { in?: number }).in ?? 0,
      speed: child.type === "clip" ? clipBaseSpeed(child) : 1,
    };
    return rewriteSplitAnchors(nextDoc, ctx);
  };

  // Clip: split via source in/out.
  if (child.type === "clip") {
    const speed = clipBaseSpeed(child);
    const splitSource = child.in + offset * speed;
    const { duration: _d, ...base } = child;
    const first: Clip = { ...base, out: splitSource };
    const second: Clip = { ...base, in: splitSource };
    if (rightId != null) second.id = rightId;
    else delete (second as { id?: string }).id;
    newChildren.splice(targetIdx, 1, first, second);
    return applyAnchorRewrite({ ...doc, children: newChildren });
  }

  // Ref: already a shared definition; just split the window.
  if (child.type === "ref") {
    // The ref's in/out windows the def's resolved duration. Resolve the
    // current document with the ref expanded to find the effective duration.
    const refIn = child.in ?? 0;
    const refOut = child.out ?? refIn + origLen;
    const splitPoint = refIn + offset;
    const first: RefChild = { ...child, in: refIn, out: splitPoint };
    const second: RefChild = { ...child, in: splitPoint, out: refOut };
    if (rightId != null) second.id = rightId;
    else delete (second as { id?: string }).id;
    newChildren.splice(targetIdx, 1, first, second);
    return applyAnchorRewrite({ ...doc, children: newChildren });
  }

  // Composition: promote to a ref before splitting so both halves share a
  // single underlying definition.
  if (child.type === "composition") {
    const innerDuration = resolveComposition(child).duration;
    const childIn = child.in ?? 0;
    const childOut = child.out ?? innerDuration;
    const splitPoint = childIn + offset;

    // Strip the child's own `in`/`out`/`flex`/`id` before making it a ref
    // def — those lived on the original child as usage-site state. The
    // definition itself should be "naked" so ref siblings can window it
    // without inheriting a duplicate id at each inlining.
    const {
      in: _i,
      out: _o,
      flex: _f,
      overflow: _ov,
      underflow: _uf,
      id: _id,
      ...defBase
    } = child as typeof child & { flex?: number; id?: string };
    const def = defBase as Child;

    const refName = uniqueRefName(doc.refs, "split");
    const newRefs = { ...(doc.refs ?? {}), [refName]: def };

    const first: RefChild = {
      type: "ref",
      source: refName,
      in: childIn,
      out: splitPoint,
      ...(origId != null ? { id: origId } : {}),
    };
    const second: RefChild = {
      type: "ref",
      source: refName,
      in: splitPoint,
      out: childOut,
      ...(rightId != null ? { id: rightId } : {}),
    };
    newChildren.splice(targetIdx, 1, first, second);

    return applyAnchorRewrite({
      ...doc,
      refs: newRefs,
      children: newChildren,
    });
  }

  return null;
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
  width: 44,
  height: 44,
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

const ICON_SIZE = 20;

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
        <button onClick={restart} style={BTN_STYLE} title="Restart">
          <SkipBack size={ICON_SIZE} />
        </button>
        <button
          onClick={isPlaying ? pause : play}
          style={BTN_STYLE}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={ICON_SIZE} /> : <Play size={ICON_SIZE} />}
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
            <button onClick={handleSlice} style={BTN_STYLE} title="Slice (S)">
              <Scissors size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                const clipIdx = [...selectedIndices]
                  .sort((a, b) => a - b)
                  .find((i) => doc.children[i]?.type === "clip");
                if (clipIdx != null) onEnterClip(clipIdx, currentTime);
              }}
              style={{
                ...BTN_STYLE,
                opacity: selectedIndices.some(
                  (i) => doc.children[i]?.type === "clip"
                )
                  ? 1
                  : 0.3,
              }}
              disabled={
                !selectedIndices.some((i) => doc.children[i]?.type === "clip")
              }
              title="Enter clip (double-click)"
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
          accept="video/*"
          multiple
          onChange={handleFileInput}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
