import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import { resolveComposition } from "@seam/core";
import type {
  SeamFile,
  Child,
  Composition,
  TimeAnchor,
  ResolvedChild,
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
  AlignStartVertical,
  AlignEndVertical,
  Captions,
  Group,
  Box,
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { View } from "./views.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import {
  applyCompose,
  isComposableSelection,
  walkComposeDependencies,
} from "./composeTool.js";
import { applyBin, canBin } from "./binTool.js";
import { isTypingInEditableSurface } from "./keyboardGuards.js";

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
  /** Trigger CC/transcript generation for the current selection (or all). */
  onTranscribe: () => void;
  /** True while a transcription job is running — disables the CC button. */
  transcribing: boolean;
  /** CC-cut view: commit selections and splice into the root doc. */
  onCCCutOk: () => void;
  /** CC-cut view: discard selections and exit. */
  onCCCutCancel: () => void;
  /** True when the CC-cut user has at least one selection (gates OK). */
  ccCutHasSelections: boolean;
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
  if (node.type === "text") return node.duration ?? 0;
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
  if (
    child.type !== "clip" &&
    child.type !== "audio" &&
    child.type !== "composition"
  ) {
    // Splitting empty/data/text has no clear meaning — bail.
    return null;
  }

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

  let first: Child;
  let second: Child;
  let splitContext: SplitContext | null = null;

  if (child.type === "clip" || child.type === "audio") {
    const speed = clipBaseSpeed(child);
    const splitSource = child.in + offset * speed;
    const { duration: _d, ...base } = child;
    first = { ...base, out: splitSource } as typeof child;
    second = { ...base, in: splitSource } as typeof child;
    if (rightId != null) (second as { id?: string }).id = rightId;
    else delete (second as { id?: string }).id;
    if (origId != null && rightId != null) {
      splitContext = {
        origId,
        rightId,
        splitOffset: offset,
        origLen,
        baseSourceTime: child.in,
        speed,
      };
    }
  } else {
    // Composition: both halves share the same body (children +
    // attachments + spatial fields + metadata + filters + script/bin
    // payload). They differ only in the inner-timeline window — first
    // keeps [compIn..innerSplit], second takes [innerSplit..compOut].
    // Child compositions always run at unit speed (overflow/underflow
    // stretching only kicks in for anchored attachments), so the
    // output-offset translates 1:1 to inner-timeline coordinates.
    const compIn = child.in ?? 0;
    const resolvedComp = resolved.children[targetIdx];
    const compOut = child.out ?? compIn + resolvedComp.duration;
    const innerSplit = compIn + offset;
    first = { ...child, in: compIn, out: innerSplit };
    second = { ...child, in: innerSplit, out: compOut };
    if (rightId != null) (second as { id?: string }).id = rightId;
    else delete (second as { id?: string }).id;
    if (origId != null && rightId != null) {
      splitContext = {
        origId,
        rightId,
        splitOffset: offset,
        origLen,
        baseSourceTime: compIn,
        speed: 1,
      };
    }
  }

  newChildren.splice(targetIdx, 1, first, second);
  let nextDoc: SeamFile = { ...doc, children: newChildren };
  if (splitContext) nextDoc = rewriteSplitAnchors(nextDoc, splitContext);
  return nextDoc;
}

// ── Attach tool ──────────────────────────────────────────────────────

/** Pick a unique id for an attach target, starting from `base`. */
function pickFreshId(existingIds: Set<string>, base: string): string {
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * Source-time of the playhead within `primary`, clamped to its source range.
 * Maps the resolver's source→output formula in reverse:
 *   source_time = base + (output_time − timelineStart) * speed
 * where `base` is `sourceIn` (clip/audio) or `in ?? 0` (composition).
 *
 * Returns null for primaries that have no meaningful source axis (data,
 * empty) — the attach tool is disabled in those cases.
 */
function sourceAnchorPoint(
  primary: Child,
  resolved: ResolvedChild,
  t: number
): number | null {
  if (
    (primary.type === "clip" || primary.type === "audio") &&
    (resolved.type === "clip" || resolved.type === "audio")
  ) {
    const sourceTime =
      resolved.sourceIn + (t - resolved.timelineStart) * resolved.speed;
    return Math.max(primary.in, Math.min(primary.out, sourceTime));
  }
  if (primary.type === "composition" && resolved.type === "composition") {
    const compIn = primary.in ?? 0;
    // Resolved duration is in OUTPUT seconds; window length on the inner
    // (source) timeline is `duration * speed`. compIn..compIn+windowLen is
    // the visible source range to clamp into.
    const compOut = compIn + resolved.duration * resolved.speed;
    const sourceTime =
      compIn + (t - resolved.timelineStart) * resolved.speed;
    return Math.max(compIn, Math.min(compOut, sourceTime));
  }
  return null;
}

/**
 * Move every secondary out of `children` and into `attachments`, anchoring
 * either the secondary's `start` or `end` to a source-mode point on the
 * primary at the playhead. Auto-assigns an id to the primary if it lacks one.
 *
 * Returns null if the action isn't applicable (fewer than 2 selections, or
 * the primary type has no source axis).
 */
function applyAttach(
  doc: SeamFile,
  currentTime: number,
  selectedIndices: number[],
  side: "start" | "end"
): SeamFile | null {
  if (selectedIndices.length < 2) return null;
  const [primaryIdx, ...secondaryIdx] = selectedIndices;
  const primary = doc.children[primaryIdx];
  if (!primary) return null;

  let resolved;
  try {
    resolved = resolveComposition(doc);
  } catch {
    return null;
  }
  const resolvedPrimary = resolved.children[primaryIdx];
  if (!resolvedPrimary) return null;

  const anchorPoint = sourceAnchorPoint(primary, resolvedPrimary, currentTime);
  if (anchorPoint == null) return null;

  // Ensure the primary has an id so the attachments can reference it.
  const existingIds = collectAllIds(doc);
  let primaryId = (primary as { id?: string }).id;
  let updatedPrimary: Child = primary;
  if (primaryId == null) {
    primaryId = pickFreshId(existingIds, "anchor");
    updatedPrimary = { ...primary, id: primaryId } as Child;
  }

  const anchor: TimeAnchor = {
    anchor: primaryId,
    timeSource: "source",
    anchorPoint,
    offset: 0,
  };

  const newChildren = [...doc.children];
  newChildren[primaryIdx] = updatedPrimary;

  // Build the new attachment list in original child order so z-order is
  // predictable (earlier-in-doc renders below later-in-doc among the new
  // attachments).
  const sortedSecAsc = [...secondaryIdx].sort((a, b) => a - b);
  const newAttachments: Child[] = [];
  for (const i of sortedSecAsc) {
    const node = doc.children[i];
    if (!node) continue;
    const updated = { ...node } as Child;
    if (side === "start") {
      (updated as { start?: TimeAnchor }).start = anchor;
    } else {
      (updated as { end?: TimeAnchor }).end = anchor;
    }
    newAttachments.push(updated);
  }

  // Splice descending so earlier indices stay valid.
  const sortedSecDesc = [...secondaryIdx].sort((a, b) => b - a);
  for (const i of sortedSecDesc) newChildren.splice(i, 1);

  return {
    ...doc,
    children: newChildren,
    attachments: [...(doc.attachments ?? []), ...newAttachments],
  };
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

const BTN_PRIMARY_TEXT: React.CSSProperties = {
  background: "#4a7eb8",
  border: "none",
  color: "#fff",
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
  height: 28,
  flexShrink: 0,
};

const BTN_PRIMARY_TEXT_DISABLED: React.CSSProperties = {
  ...BTN_PRIMARY_TEXT,
  background: "#2a2a2a",
  color: "#666",
  cursor: "not-allowed",
};

const BTN_SECONDARY_TEXT: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #555",
  color: "#ddd",
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
  height: 28,
  flexShrink: 0,
};

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
  onTranscribe,
  transcribing,
  onCCCutOk,
  onCCCutCancel,
  ccCutHasSelections,
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

  // S key shortcut (disabled in non-root views and while typing in any
  // editable surface — otherwise typing "s" into the JSON / Script
  // editor or a rename input would slice the playhead clip).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view.type !== "root") return;
      if (isTypingInEditableSurface(e)) return;
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        handleSlice();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSlice, view]);

  // Escape to exit a nested view — skipped when typing in an editable
  // surface so Monaco's own Esc handlers (close suggest widget, exit
  // find, etc.) and rename inputs work normally.
  useEffect(() => {
    if (view.type === "root") return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
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

  // Slice is enabled when at least one selected (or playhead-targeted)
  // child is a sliceable type: clip, audio, or composition.
  const isSliceableType = (t: string | undefined) =>
    t === "clip" || t === "audio" || t === "composition";
  const canSlice = selectedIndices.length === 0
    ? doc.children.some((c) => isSliceableType(c.type))
    : selectedIndices.some((i) => isSliceableType(doc.children[i]?.type));

  // Attach: needs 2+ selected, all of which are children (not attachments),
  // and a primary with a source axis.
  const canAttach = (() => {
    if (selectedIndices.length < 2) return false;
    if (selectedIndices.some((i) => i >= doc.children.length)) return false;
    const primary = doc.children[selectedIndices[0]];
    if (!primary) return false;
    return (
      primary.type === "clip" ||
      primary.type === "audio" ||
      primary.type === "composition"
    );
  })();

  const handleAttach = useCallback(
    (side: "start" | "end") => {
      const next = applyAttach(doc, currentTime, selectedIndices, side);
      if (next) {
        onDocumentChange(next);
        onSelectionChange([]);
      }
    },
    [doc, currentTime, selectedIndices, onDocumentChange, onSelectionChange]
  );

  // ── Compose ────────────────────────────────────────────────────
  // Active when the user has selected a non-empty, contiguous run of
  // children (no attachments mixed in). The dependency walk + extend +
  // confirm flow lives inside handleCompose so the gate stays cheap.
  const canCompose =
    view.type === "root" &&
    selectedIndices.length > 0 &&
    selectedIndices.every((i) => i < doc.children.length) &&
    isComposableSelection(selectedIndices, doc.children.length);

  const handleCompose = useCallback(() => {
    if (!canCompose) return;
    const walk = walkComposeDependencies(doc, selectedIndices);
    if (walk.extraChildren > 0) {
      const word = walk.extraChildren === 1 ? "clip" : "clips";
      const ok = window.confirm(
        `Composing will also pull in ${walk.extraChildren} more ${word} ` +
          `because one or more attachments anchor outside your selection. ` +
          `Proceed?`,
      );
      if (!ok) return;
    }
    const next = applyCompose(doc, walk);
    onDocumentChange(next);
    // Select the newly-created composition so the user can immediately
    // act on it (e.g. promote to bin).
    onSelectionChange([walk.childIndices[0]]);
  }, [canCompose, doc, selectedIndices, onDocumentChange, onSelectionChange]);

  // ── Bin ────────────────────────────────────────────────────────
  const canBinSelection =
    view.type === "root" &&
    selectedIndices.length === 1 &&
    canBin(doc, selectedIndices[0]);

  const handleBin = useCallback(() => {
    if (!canBinSelection) return;
    const result = applyBin(doc, selectedIndices[0]);
    if (!result) return;
    onDocumentChange(result.doc);
    // Keep the (now bin-referencing) composition selected so the user
    // can see the change in place.
    onSelectionChange([selectedIndices[0]]);
  }, [canBinSelection, doc, selectedIndices, onDocumentChange, onSelectionChange]);

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
              title="Slice (S) — clip, audio, or composition"
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
              onClick={() => handleAttach("start")}
              style={{ ...BTN_STYLE, opacity: canAttach ? 1 : 0.3 }}
              disabled={!canAttach}
              title="Attach start of secondaries to the primary at the playhead"
            >
              <AlignStartVertical size={ICON_SIZE} />
            </button>
            <button
              onClick={() => handleAttach("end")}
              style={{ ...BTN_STYLE, opacity: canAttach ? 1 : 0.3 }}
              disabled={!canAttach}
              title="Attach end of secondaries to the primary at the playhead"
            >
              <AlignEndVertical size={ICON_SIZE} />
            </button>
            <button
              onClick={handleCompose}
              style={{ ...BTN_STYLE, opacity: canCompose ? 1 : 0.3 }}
              disabled={!canCompose}
              title="Compose selected children (and their dependent attachments) into a new composition"
            >
              <Group size={ICON_SIZE} />
            </button>
            <button
              onClick={handleBin}
              style={{ ...BTN_STYLE, opacity: canBinSelection ? 1 : 0.3 }}
              disabled={!canBinSelection}
              title="Bin: promote the selected composition into a reusable bin entry"
            >
              <Box size={ICON_SIZE} />
            </button>
            <button
              onClick={() => {
                if (selectedIndices.length > 0) {
                  onDocumentChange(removeSelected(doc, selectedIndices));
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
            <button
              onClick={onTranscribe}
              disabled={transcribing}
              style={{
                ...BTN_STYLE,
                opacity: transcribing ? 0.3 : 1,
              }}
              title={
                selectedIndices.length > 0
                  ? "Generate transcripts for the selected clip/audio nodes"
                  : "Generate transcripts for all clip/audio children"
              }
            >
              <Captions size={ICON_SIZE} />
            </button>
          </>
        ) : view.type === "cc-cut" ? (
          <>
            <button
              onClick={onCCCutCancel}
              style={BTN_SECONDARY_TEXT}
              title="Discard selections and exit CC Cut"
            >
              Cancel
            </button>
            <button
              onClick={onCCCutOk}
              disabled={!ccCutHasSelections}
              style={
                ccCutHasSelections ? BTN_PRIMARY_TEXT : BTN_PRIMARY_TEXT_DISABLED
              }
              title={
                ccCutHasSelections
                  ? "Splice selections into the root composition"
                  : "Make at least one selection first"
              }
            >
              OK
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
