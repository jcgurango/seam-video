import React, { useCallback, useEffect, useRef } from "react";
import { useTimeline } from "@seam/preview";
import type { SeamFile } from "@seam/core";
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
  AlignStartVertical,
  AlignEndVertical,
  Captions,
  Group,
  Box,
  Split,
  Combine,
  AudioLines,
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { ResolvedTimeline } from "@seam/core";
import {
  editContainer,
  getNodeAtPath,
  parsePath,
  type NodePath,
} from "./nodePath.js";
import { descendToContainer } from "./resolveLocal.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import {
  applyCompose,
  composeAttachments,
  isComposableSelection,
  walkComposeDependencies,
} from "./composeTool.js";
import { applyBin, canBin } from "./binTool.js";
import { normalizeTargets } from "./normalizeTool.js";
import { sliceAtPlayhead } from "./splitTool.js";
import { applyAttach } from "./attachTool.js";
import {
  separateByWord,
  groupWords,
  childAtBlockIndex,
  isTranscriptionWords,
  isWordItem,
} from "./wordTool.js";
import { isTypingInEditableSurface } from "./keyboardGuards.js";

interface ControlsBarProps {
  document: SeamFile;
  filePath: string | null;
  selectedIndices: number[];
  /** Path-key selection (for the attach tool, which is path-aware). */
  selection: string[];
  /** Resolved editor timeline — used to map the playhead onto the attach
   *  primary's source. */
  timeline: ResolvedTimeline;
  onSelectionChange: (indices: number[]) => void;
  onDocumentChange: (doc: SeamFile) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** True while CC-cut mode is active — swaps the edit toolbar for the
   *  Cancel/OK pair. */
  ccCutMode: boolean;
  platform: Platform;
  /** Trigger CC/transcript generation for the current selection (or all). */
  onTranscribe: () => void;
  /** True while a transcription job is running — disables the CC button. */
  transcribing: boolean;
  /** Peak-normalize the selected clip/audio nodes to -1 dBFS. */
  onNormalize: () => void;
  /** True while a normalize job is decoding — disables the button. */
  normalizing: boolean;
  /** CC-cut mode: commit selections and splice into the root doc. */
  onCCCutOk: () => void;
  /** CC-cut mode: discard selections and exit. */
  onCCCutCancel: () => void;
  /** True when the CC-cut user has at least one selection (gates OK). */
  ccCutHasSelections: boolean;
}

// Slice + attach logic lives in splitTool.ts / attachTool.ts.

/** The container to slice in for the current selection: the parent of the
 *  deepest-nested selected node ([] = root). Null when the deepest selection
 *  is bin-rooted (its per-reference playhead is ambiguous) — the caller falls
 *  back to the root. */
function sliceContainerPath(selection: string[]): NodePath | null {
  if (selection.length === 0) return [];
  let deepest = parsePath(selection[0]);
  for (const key of selection) {
    const p = parsePath(key);
    if (p.length > deepest.length) deepest = p;
  }
  if (deepest.some((s) => s.field === "bin")) return null;
  return deepest.slice(0, -1);
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
  selection,
  timeline,
  onSelectionChange,
  onDocumentChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  ccCutMode,
  platform,
  onTranscribe,
  transcribing,
  onNormalize,
  normalizing,
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
    // Deepest selected level wins: slice inside the container of the
    // deepest-nested selection (don't bubble up). Empty / root selection
    // slices the root. Bin-rooted selections fall back to the root (their
    // per-reference playhead is ambiguous).
    const containerPath = sliceContainerPath(selection);
    if (containerPath == null || containerPath.length === 0) {
      const nextDoc = sliceAtPlayhead(doc, currentTime);
      if (nextDoc) onDocumentChange(nextDoc);
      return;
    }
    const desc = descendToContainer(timeline, doc, containerPath, currentTime);
    if (!desc) return;
    const rootBin = doc.bin ?? [];
    const next = editContainer(doc, containerPath, rootBin, (sub) =>
      sliceAtPlayhead(sub, desc.localTime),
    );
    if (next !== doc) onDocumentChange(next);
  }, [doc, timeline, currentTime, selection, onDocumentChange]);

  // S key shortcut (disabled in CC-cut mode and while typing in any
  // editable surface — otherwise typing "s" into the JSON / Script
  // editor or a rename input would slice the playhead clip).
  useEffect(() => {
    if (ccCutMode) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        handleSlice();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSlice, ccCutMode]);

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

  // Slice is enabled when something is selected (it slices whatever the
  // playhead crosses in that selection's container) or — with nothing
  // selected — the root has a sliceable (clip/audio/composition) child.
  const isSliceableType = (t: string | undefined) =>
    t === "clip" || t === "audio" || t === "composition";
  const canSlice =
    selection.length > 0 || doc.children.some((c) => isSliceableType(c.type));

  // Attach: needs 2+ selected and a resolvable primary (first selection).
  // The primary and secondaries can each be any node type (the file format
  // lets you anchor to anything — empties included) and can each be a child
  // OR an attachment, at any level: secondaries are pulled into the primary's
  // container and anchored/re-anchored on the chosen side. Bin-rooted
  // primaries are out (the per-reference playhead is ambiguous).
  const canAttach = (() => {
    if (selection.length < 2) return false;
    const pp = parsePath(selection[0]);
    if (pp.length === 0 || pp.some((s) => s.field === "bin")) return false;
    return getNodeAtPath(doc, pp) != null;
  })();

  const handleAttach = useCallback(
    (side: "start" | "end") => {
      if (selection.length < 2) return;
      const [primaryKey, ...secondaryKeys] = selection;
      const next = applyAttach(
        doc,
        timeline,
        currentTime,
        primaryKey,
        secondaryKeys,
        side,
      );
      if (next) {
        onDocumentChange(next);
        onSelectionChange([]);
      }
    },
    [doc, timeline, currentTime, selection, onDocumentChange, onSelectionChange]
  );

  // ── Compose ────────────────────────────────────────────────────
  // Two distinct selections enable Compose:
  //   • a non-empty, contiguous run of *children* (the original tool —
  //     clubs them, plus their dependent attachments, into one comp);
  //   • one or more *attachments* (wrap each in a composition that takes
  //     over its slot — see `composeAttachments`).
  // Mixed child/attachment selections are not composable.
  const childCount = doc.children.length;
  const composeChildrenOk =
    selectedIndices.length > 0 &&
    selectedIndices.every((i) => i < childCount) &&
    isComposableSelection(selectedIndices, childCount);
  const composeAttachmentsOk =
    selectedIndices.length > 0 &&
    selectedIndices.every((i) => i >= childCount);
  const canCompose = composeChildrenOk || composeAttachmentsOk;

  const handleCompose = useCallback(() => {
    const cc = doc.children.length;
    // Attachment compose: wrap each selected attachment in its own
    // composition (lifting start/end/id). No dependency walk / confirm.
    if (
      selectedIndices.length > 0 &&
      selectedIndices.every((i) => i >= cc)
    ) {
      const next = composeAttachments(
        doc,
        selectedIndices.map((i) => i - cc),
      );
      onDocumentChange(next);
      // The new comps occupy the same attachment slots — keep them selected.
      onSelectionChange(selectedIndices);
      return;
    }
    if (
      !(
        selectedIndices.length > 0 &&
        selectedIndices.every((i) => i < cc) &&
        isComposableSelection(selectedIndices, cc)
      )
    ) {
      return;
    }
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
  }, [doc, selectedIndices, onDocumentChange, onSelectionChange]);

  // ── Bin ────────────────────────────────────────────────────────
  const canBinSelection =
    selectedIndices.length === 1 && canBin(doc, selectedIndices[0]);

  const handleBin = useCallback(() => {
    if (!canBinSelection) return;
    const result = applyBin(doc, selectedIndices[0]);
    if (!result) return;
    onDocumentChange(result.doc);
    // Keep the (now bin-referencing) composition selected so the user
    // can see the change in place.
    onSelectionChange([selectedIndices[0]]);
  }, [canBinSelection, doc, selectedIndices, onDocumentChange, onSelectionChange]);

  // ── Normalize ──────────────────────────────────────────────────
  // Enabled when the path-keyed selection contains at least one clip/audio
  // node (compositions and other types are ignored by the tool).
  const canNormalize =
    !normalizing &&
    normalizeTargets(doc, selection.map(parsePath)).length > 0;

  // ── Word tools ─────────────────────────────────────────────────
  // Separate by word: one or more CC transcription items (with a words
  // array) selected. Group words: 2+ per-word items selected.
  const canSeparateWords =
    selectedIndices.length > 0 &&
    selectedIndices.every((i) =>
      isTranscriptionWords(childAtBlockIndex(doc, i)),
    );

  const canGroupWords =
    selectedIndices.length >= 2 &&
    selectedIndices.every((i) => isWordItem(childAtBlockIndex(doc, i)));

  const handleSeparateWords = useCallback(() => {
    const result = separateByWord(doc, selectedIndices);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    onDocumentChange(result.doc);
    onSelectionChange([]);
  }, [doc, selectedIndices, onDocumentChange, onSelectionChange]);

  const handleGroupWords = useCallback(() => {
    const result = groupWords(doc, selectedIndices);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    onDocumentChange(result.doc);
    onSelectionChange([]);
  }, [doc, selectedIndices, onDocumentChange, onSelectionChange]);

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
        {!ccCutMode ? (
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
              title="Compose: club selected children (+ dependent attachments) into one composition, or wrap each selected attachment in a composition"
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
              onClick={handleSeparateWords}
              style={{ ...BTN_STYLE, opacity: canSeparateWords ? 1 : 0.3 }}
              disabled={!canSeparateWords}
              title="Separate by word: split a CC transcription into one item per word"
            >
              <Split size={ICON_SIZE} />
            </button>
            <button
              onClick={handleGroupWords}
              style={{ ...BTN_STYLE, opacity: canGroupWords ? 1 : 0.3 }}
              disabled={!canGroupWords}
              title="Group words: merge selected word items back into one phrase"
            >
              <Combine size={ICON_SIZE} />
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
              disabled={transcribing || selectedIndices.length === 0}
              style={{
                ...BTN_STYLE,
                opacity:
                  transcribing || selectedIndices.length === 0 ? 0.3 : 1,
              }}
              title={
                selectedIndices.length === 0
                  ? "Select a clip, audio, or composition to generate subtitles"
                  : "Generate subtitles for the selected clip/audio/composition nodes"
              }
            >
              <Captions size={ICON_SIZE} />
            </button>
            <button
              onClick={onNormalize}
              disabled={!canNormalize}
              style={{ ...BTN_STYLE, opacity: canNormalize ? 1 : 0.3 }}
              title={
                normalizing
                  ? "Normalizing…"
                  : "Normalize the selected clip/audio to -1 dB peak"
              }
            >
              <AudioLines size={ICON_SIZE} />
            </button>
          </>
        ) : (
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
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          onChange={handleFileInput}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
