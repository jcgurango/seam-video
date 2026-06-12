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
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import {
  applyCompose,
  isComposableSelection,
  walkComposeDependencies,
} from "./composeTool.js";
import { applyBin, canBin } from "./binTool.js";
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
  /** CC-cut mode: commit selections and splice into the root doc. */
  onCCCutOk: () => void;
  /** CC-cut mode: discard selections and exit. */
  onCCCutCancel: () => void;
  /** True when the CC-cut user has at least one selection (gates OK). */
  ccCutHasSelections: boolean;
}

// Slice + attach logic lives in splitTool.ts / attachTool.ts.


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
  ccCutMode,
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
