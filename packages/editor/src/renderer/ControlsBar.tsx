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
  ArrowLeftToLine,
  ArrowRightToLine,
  Group,
  Box,
  AudioLines,
} from "lucide-react";
import { useImport } from "./useImport.js";
import type { EditorCommand, EditorCommandContext, EditorView, ResolvedTimeline } from "@seam/core";
import {
  editContainer,
  getNodeAtPath,
  parsePath,
  rootKeyFromIndex,
  type NodePath,
} from "./nodePath.js";
import { descendToContainer } from "./resolveLocal.js";
import type { Platform } from "./platform/index.js";
import { removeSelected } from "./selection.js";
import { playheadAfterDelete } from "./deletePlayhead.js";
import { applyCompose } from "./composeTool.js";
import { applyBin, canBin } from "./binTool.js";
import { normalizeTargets } from "./normalizeTool.js";
import { sliceAtPlayhead } from "./splitTool.js";
import { applyAttach } from "./attachTool.js";
import { applyBracket } from "./bracketTool.js";
import { isTypingInEditableSurface } from "./keyboardGuards.js";
import { useSeam } from "./seamContext.js";

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
  /** Path-key selection setter (attach / compose re-select moved nodes). */
  onPathSelectionChange: (keys: string[]) => void;
  onDocumentChange: (doc: SeamFile) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  platform: Platform;
  /** Peak-normalize the selected clip/audio nodes to -1 dBFS. */
  onNormalize: () => void;
  /** True while a normalize job is decoding — disables the button. */
  normalizing: boolean;
  /** Toolbar commands contributed by extensions, and the context they run in. */
  extensionCommands?: readonly EditorCommand[];
  commandContext?: EditorCommandContext;
  /** Views contributed by extensions: one toolbar button each, opening the
   *  view on the primary selection. */
  extensionViews?: readonly EditorView[];
  onOpenView?: (view: EditorView) => void;
  /** True while an extension view is open — the edit tools are hidden (the
   *  view carries its own apply / cancel). */
  viewOpen?: boolean;
}

// Slice + attach logic lives in splitTool.ts / attachTool.ts.

/** The container to slice in for the current selection: the parent of the
 *  deepest-nested selected node ([] = root). Null when the deepest selection
 *  is bin-rooted (its per-reference playhead is ambiguous) — the caller falls
 *  back to the root. */


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
  selection,
  timeline,
  onSelectionChange,
  onPathSelectionChange,
  onDocumentChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  platform,
  onNormalize,
  normalizing,
  extensionCommands = [],
  commandContext,
  extensionViews = [],
  onOpenView,
  viewOpen = false,
}: ControlsBarProps) {
  const seam = useSeam();
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
    // Nothing selected: split everything splittable under the playhead at
    // the root. With a selection: split only the selected nodes, each in its
    // own container (bin-rooted selections are skipped — their per-reference
    // playhead is ambiguous).
    if (selection.length === 0) {
      const nextDoc = sliceAtPlayhead(seam, doc, currentTime);
      if (nextDoc) onDocumentChange(nextDoc);
      return;
    }
    const groups = new Map<string, { path: NodePath; indices: Set<number> }>();
    for (const key of selection) {
      const p = parsePath(key);
      if (p.length === 0 || p.some((s) => s.field === "bin")) continue;
      const parent = p.slice(0, -1);
      const k = parent.map((s) => s.index).join(".");
      if (!groups.has(k)) groups.set(k, { path: parent, indices: new Set() });
      groups.get(k)!.indices.add(p[p.length - 1].index);
    }
    // Deepest container first: a split shifts later siblings, which would
    // invalidate the paths of containers nested under them.
    const ordered = [...groups.values()].sort((a, b) => b.path.length - a.path.length);
    const rootBin = doc.bin ?? [];
    let next = doc;
    for (const g of ordered) {
      // Local time is read off the ORIGINAL doc/timeline (splits don't move
      // anything in time); the edit lands on the accumulated one.
      const desc = descendToContainer(seam, timeline, doc, g.path, currentTime);
      if (!desc) continue;
      next = editContainer(next, g.path, rootBin, (sub) =>
        sliceAtPlayhead(seam, sub, desc.localTime, g.indices),
      );
    }
    if (next !== doc) onDocumentChange(next);
  }, [doc, timeline, currentTime, selection, onDocumentChange]);

  // S key shortcut (disabled while an extension view is open and while typing in any
  // editable surface — otherwise typing "s" into the JSON / Script
  // editor or a rename input would slice the playhead clip).
  useEffect(() => {
    if (viewOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        handleSlice();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSlice, viewOpen]);

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
    t === "clip" ||
    t === "audio" ||
    t === "composition" ||
    (t != null && seam.nodeTypes.get(t)?.editor?.split != null);
  const canSlice =
    selection.length > 0 ||
    (doc.children ?? []).some((c) => isSliceableType(c.type));

  // Attach: needs 2+ selected and a resolvable primary (first selection).
  // The primary and secondaries can each be any node type (the file format
  // lets you anchor to anything) at any level: each secondary is lifted into
  // the primary's container as the head of its own run, anchored to the
  // primary at the playhead but left where it is. Bin-rooted primaries are out
  // (the per-reference playhead is ambiguous).
  const canAttach = (() => {
    if (selection.length < 2) return false;
    const pp = parsePath(selection[0]);
    if (pp.length === 0 || pp.some((s) => s.field === "bin")) return false;
    return getNodeAtPath(doc, pp) != null;
  })();

  const handleAttach = useCallback(() => {
    if (selection.length < 2) return;
    const [primaryKey, ...secondaryKeys] = selection;
    const result = applyAttach(seam, doc, timeline, currentTime, primaryKey, secondaryKeys);
    if (result) {
      onDocumentChange(result.doc);
      // Keep the roles selected so the anchor lines show immediately.
      onPathSelectionChange([result.primaryKey, ...result.secondaryKeys]);
    }
  }, [doc, timeline, currentTime, selection, onDocumentChange, onPathSelectionChange]);

  // ── Bracket ────────────────────────────────────────────────────
  // Selection shape mirrors attach (primary + secondaries, any level,
  // non-bin primary), but a lone primary also works — it brackets the
  // primary itself against the playhead. Bracket edits nodes in place
  // (nothing moves), so the selection is kept.
  const canBracket = (() => {
    if (selection.length < 1) return false;
    const pp = parsePath(selection[0]);
    if (pp.length === 0 || pp.some((s) => s.field === "bin")) return false;
    return getNodeAtPath(doc, pp) != null;
  })();

  const handleBracket = useCallback(
    (side: "start" | "end") => {
      if (selection.length < 1) return;
      const [primaryKey, ...secondaryKeys] = selection;
      const next = applyBracket(seam,
        doc,
        timeline,
        currentTime,
        primaryKey,
        secondaryKeys,
        side,
      );
      if (next) onDocumentChange(next);
    },
    [doc, timeline, currentTime, selection, onDocumentChange]
  );

  // ── Compose ────────────────────────────────────────────────────
  // Any selection that sits in ONE editable container composes: the nodes
  // (plus any runs anchored to them) are wrapped in a composition that takes
  // the first one's slot — see `composeTool.ts`.
  const composeTarget = (() => {
    if (selection.length === 0) return null;
    const paths = selection.map(parsePath);
    if (paths.some((p) => p.length === 0 || p[p.length - 1].field === "bin")) return null;
    const container = paths[0].slice(0, -1);
    const key = container.map((s) => `${s.field}.${s.id ?? s.index}`).join(".");
    for (const p of paths) {
      const k = p.slice(0, -1).map((s) => `${s.field}.${s.id ?? s.index}`).join(".");
      if (k !== key) return null;
    }
    return { container, indices: paths.map((p) => p[p.length - 1].index) };
  })();
  const canCompose = composeTarget != null;

  const handleCompose = useCallback(() => {
    if (!composeTarget) return;
    let wrapperIndex = -1;
    const next = editContainer(doc, composeTarget.container, doc.bin ?? [], (sub) => {
      const result = applyCompose(sub, composeTarget.indices);
      if (!result) return null;
      wrapperIndex = result.index;
      return result.container;
    });
    if (wrapperIndex < 0 || next === doc) return;
    onDocumentChange(next);
    // Select the new composition so the user can immediately act on it
    // (e.g. promote to bin).
    const prefix = selection[0].split(".").slice(0, -1).join(".");
    onPathSelectionChange([`${prefix}.${wrapperIndex}`]);
  }, [doc, composeTarget, selection, onDocumentChange, onPathSelectionChange]);

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
        {viewOpen ? null : (
          <>
            <button onClick={handleImportClick} style={BTN_STYLE} title="Import">
              <FolderOpen size={ICON_SIZE} />
            </button>
            <button
              onClick={handleSlice}
              style={{ ...BTN_STYLE, opacity: canSlice ? 1 : 0.3 }}
              disabled={!canSlice}
              title="Slice (S) — every clip, audio, composition or caption under the playhead (a caption cuts at the nearest word boundary); with a selection, only the selected ones"
            >
              <Scissors size={ICON_SIZE} />
            </button>
            <button
              onClick={handleAttach}
              style={{ ...BTN_STYLE, opacity: canAttach ? 1 : 0.3 }}
              disabled={!canAttach}
              title="Attach: anchor each secondary to the primary at the playhead, keeping it where it is"
            >
              <AlignStartVertical size={ICON_SIZE} />
            </button>
            <button
              onClick={() => handleBracket("start")}
              style={{ ...BTN_STYLE, opacity: canBracket ? 1 : 0.3 }}
              disabled={!canBracket}
              title="Bracket start: align each secondary's start to the primary (its start if attached to it, else its end); with only a primary, align its start to the playhead"
            >
              <ArrowLeftToLine size={ICON_SIZE} />
            </button>
            <button
              onClick={() => handleBracket("end")}
              style={{ ...BTN_STYLE, opacity: canBracket ? 1 : 0.3 }}
              disabled={!canBracket}
              title="Bracket end: align each secondary's end to the primary (its end if attached to it, else its start); with only a primary, align its end to the playhead"
            >
              <ArrowRightToLine size={ICON_SIZE} />
            </button>
            <button
              onClick={handleCompose}
              style={{ ...BTN_STYLE, opacity: canCompose ? 1 : 0.3 }}
              disabled={!canCompose}
              title="Compose: wrap the selected nodes (+ runs anchored to them) in one composition"
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
                  const nextTime = playheadAfterDelete(seam,
                    timeline,
                    doc,
                    selectedIndices.map((i) =>
                      parsePath(rootKeyFromIndex(i)),
                    ),
                    currentTime,
                  );
                  if (nextTime !== currentTime) seek(nextTime);
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
            {/* Commands contributed by extensions (e.g. Captions). */}
            {commandContext &&
              extensionCommands.map((command) => {
                const enabled = command.enabled ? command.enabled(commandContext) : true;
                return (
                  <button
                    key={command.id}
                    onClick={() => void command.run(commandContext)}
                    disabled={!enabled}
                    style={{
                      ...BTN_STYLE,
                      width: "auto",
                      minWidth: 32,
                      padding: "0 6px",
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      opacity: enabled ? 1 : 0.3,
                    }}
                    title={command.title}
                  >
                    {command.label}
                  </button>
                );
              })}
            {/* Views contributed by extensions (e.g. the CC cut). */}
            {commandContext &&
              extensionViews.map((view) => {
                const enabled = view.enabled ? view.enabled(commandContext) : true;
                return (
                  <button
                    key={view.id}
                    onClick={() => onOpenView?.(view)}
                    disabled={!enabled}
                    style={{
                      ...BTN_STYLE,
                      width: "auto",
                      minWidth: 32,
                      padding: "0 6px",
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      opacity: enabled ? 1 : 0.3,
                    }}
                    title={view.title}
                  >
                    {view.label}
                  </button>
                );
              })}
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
