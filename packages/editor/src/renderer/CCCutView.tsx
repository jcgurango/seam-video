import React, { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  CC_COLORS,
  type CCSelection,
  type CCWord,
} from "./ccCutTool.js";

export interface CCCutViewProps {
  /** Words pre-resolved to composition time, sorted by start. */
  words: CCWord[];
  /** Current selections (composition-time ranges). */
  selections: CCSelection[];
  onSelectionsChange: (next: CCSelection[]) => void;
}

/** A word's index in the rendered ribbon. Used internally for drag
 *  ranges — we resolve back to actual time on commit. */
type WordIndex = number;

interface DragState {
  /** Index of the word the user mousedown'd on. */
  anchor: WordIndex;
  /** Index of the word the cursor is currently over (or `anchor`
   *  before any move). */
  cursor: WordIndex;
  /** If non-null, this drag started on an existing selection and is
   *  editing it in place (rather than creating a new one). */
  editingIndex: number | null;
}

export default function CCCutView({
  words,
  selections,
  onSelectionsChange,
}: CCCutViewProps) {
  const [drag, setDrag] = useState<DragState | null>(null);

  // Build a quick "which selection covers this word" lookup so we can
  // shade words inside an existing selection (and detect mousedown on
  // an existing selection for in-place editing).
  const selectionForWord = useMemo(() => {
    const out: (number | null)[] = new Array(words.length).fill(null);
    selections.forEach((sel, selIdx) => {
      words.forEach((w, i) => {
        if (out[i] != null) return;
        if (wordOverlapsRange(w, sel)) out[i] = selIdx;
      });
    });
    return out;
  }, [words, selections]);

  // Words covered by the in-progress drag — used purely for visual
  // feedback while the mouse is down.
  const dragRange = useMemo(() => {
    if (!drag) return null;
    const lo = Math.min(drag.anchor, drag.cursor);
    const hi = Math.max(drag.anchor, drag.cursor);
    return { lo, hi };
  }, [drag]);

  // Global mouseup ends the drag and commits the selection. Anchoring
  // to window means the user can drag past the ribbon edge without the
  // drag getting stuck if they release outside a word.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const lo = Math.min(drag.anchor, drag.cursor);
      const hi = Math.max(drag.anchor, drag.cursor);
      const first = words[lo];
      const last = words[hi];
      if (!first || !last) {
        setDrag(null);
        return;
      }
      const newSel: CCSelection = { start: first.start, end: last.end };

      const next = [...selections];
      if (drag.editingIndex != null) {
        next[drag.editingIndex] = newSel;
      } else {
        next.push(newSel);
      }
      onSelectionsChange(next);
      setDrag(null);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [drag, words, selections, onSelectionsChange]);

  const handleMouseDownWord = (i: WordIndex, e: React.MouseEvent) => {
    e.preventDefault();
    // Mousedown on a word already inside a selection: edit-in-place
    // mode — the drag rewrites that selection's range. Mousedown
    // elsewhere: start a fresh selection.
    const existingSelIdx = selectionForWord[i];
    setDrag({
      anchor: i,
      cursor: i,
      editingIndex: existingSelIdx,
    });
  };

  const handleMouseEnterWord = (i: WordIndex) => {
    if (!drag) return;
    setDrag({ ...drag, cursor: i });
  };

  const handleDeleteSelection = (idx: number) => {
    onSelectionsChange(selections.filter((_, i) => i !== idx));
  };

  if (words.length === 0) {
    return (
      <div style={EMPTY_STYLE}>
        No transcription found inside this bin entry. CC Cut needs at
        least one <code style={CODE_STYLE}>data</code> attachment tagged{" "}
        <code style={CODE_STYLE}>"transcription"</code> with a{" "}
        <code style={CODE_STYLE}>words</code> array.
      </div>
    );
  }

  return (
    <div style={CONTAINER_STYLE}>
      <div style={RIBBON_WRAP_STYLE}>
        <div style={RIBBON_STYLE}>
          {words.map((w, i) => {
            const color = CC_COLORS[w.transcriptionIndex % CC_COLORS.length];
            const inExisting = selectionForWord[i] != null;
            const inDrag =
              dragRange != null && i >= dragRange.lo && i <= dragRange.hi;
            const inActiveDragEdit =
              drag?.editingIndex != null &&
              selectionForWord[i] === drag.editingIndex;
            const highlight = inDrag || (inExisting && !inActiveDragEdit);
            return (
              <span
                key={i}
                onMouseDown={(e) => handleMouseDownWord(i, e)}
                onMouseEnter={() => handleMouseEnterWord(i)}
                style={wordStyle(color, highlight)}
                title={`${formatTime(w.start)} → ${formatTime(w.end)}`}
              >
                {w.text}
              </span>
            );
          })}
        </div>
      </div>
      <div style={SELECTIONS_HEADER}>
        Selections ({selections.length})
      </div>
      <div style={SELECTIONS_LIST}>
        {selections.length === 0 ? (
          <div style={{ color: "#888", fontSize: 12, padding: 8 }}>
            Click and drag across words to make a selection. Drag inside
            an existing selection to edit it.
          </div>
        ) : (
          selections.map((sel, i) => (
            <div key={i} style={SELECTION_ROW}>
              <span style={SELECTION_NUM}>{i + 1}.</span>
              <span style={SELECTION_RANGE}>
                {formatTime(sel.start)} → {formatTime(sel.end)} (
                {(sel.end - sel.start).toFixed(2)}s)
              </span>
              <button
                onClick={() => handleDeleteSelection(i)}
                style={DELETE_BTN}
                title="Delete selection"
              >
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function wordOverlapsRange(
  w: { start: number; end: number },
  range: { start: number; end: number },
): boolean {
  return w.start < range.end && w.end > range.start;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function wordStyle(
  color: string,
  highlighted: boolean,
): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "3px 7px",
    margin: "2px",
    background: highlighted ? color : `${color}22`,
    color: highlighted ? "#fff" : "#ddd",
    borderRadius: 4,
    fontSize: 13,
    cursor: "text",
    userSelect: "none",
    border: `1px solid ${color}55`,
  };
}

const CONTAINER_STYLE: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  background: "#1a1a1a",
};

const RIBBON_WRAP_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: 12,
};

const RIBBON_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  lineHeight: 1.6,
};

const SELECTIONS_HEADER: React.CSSProperties = {
  padding: "6px 12px",
  background: "#1f1f1f",
  color: "#aaa",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  borderTop: "1px solid #333",
};

const SELECTIONS_LIST: React.CSSProperties = {
  maxHeight: 180,
  overflow: "auto",
  background: "#1a1a1a",
  borderTop: "1px solid #2a2a2a",
};

const SELECTION_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderBottom: "1px solid #2a2a2a",
};

const SELECTION_NUM: React.CSSProperties = {
  color: "#666",
  fontSize: 11,
  minWidth: 18,
};

const SELECTION_RANGE: React.CSSProperties = {
  flex: 1,
  color: "#ddd",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
};

const DELETE_BTN: React.CSSProperties = {
  background: "none",
  border: "1px solid #555",
  color: "#aaa",
  width: 22,
  height: 22,
  borderRadius: 4,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const EMPTY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 24,
  color: "#888",
};

const CODE_STYLE: React.CSSProperties = {
  background: "#222",
  padding: "1px 5px",
  borderRadius: 3,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};
