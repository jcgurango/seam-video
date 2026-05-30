import React, { useEffect, useMemo, useState } from "react";
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
  /** Indices into `selections` currently focused on the timeline. When
   *  non-empty, only those selections highlight in the ribbon — the
   *  rest dim so the user can concentrate on the focused range. Empty
   *  means "no focus", and all selections render at full strength. */
  focusedSelectionIndices: number[];
}

type WordIndex = number;

type DragState =
  | { kind: "create"; anchorWord: WordIndex; cursorWord: WordIndex }
  | {
      kind: "resize";
      selIdx: number;
      side: "start" | "end";
      cursorWord: WordIndex;
    };

export default function CCCutView({
  words,
  selections,
  onSelectionsChange,
  focusedSelectionIndices,
}: CCCutViewProps) {
  const [drag, setDrag] = useState<DragState | null>(null);

  // Apply the in-progress drag to a copy of `selections` so the
  // ribbon visuals (highlight + handle positions) preview the
  // would-be final shape before the user releases. The committed
  // selections stay in props until mouseup.
  const effectiveSelections = useMemo<CCSelection[]>(() => {
    if (!drag || drag.kind !== "resize") return selections;
    const w = words[drag.cursorWord];
    if (!w) return selections;
    return selections.map((sel, i) => {
      if (i !== drag.selIdx) return sel;
      if (drag.side === "start") {
        return { start: Math.min(w.start, sel.end), end: sel.end };
      }
      return { start: sel.start, end: Math.max(w.end, sel.start) };
    });
  }, [drag, words, selections]);

  // For each word, the list of selection indices that cover it. Built
  // once per render so the handle layout + per-word styling can both
  // share it without recomputing.
  const selectionsForWord = useMemo<number[][]>(() => {
    const out: number[][] = words.map(() => []);
    effectiveSelections.forEach((sel, selIdx) => {
      words.forEach((w, i) => {
        if (wordOverlapsRange(w, sel)) out[i].push(selIdx);
      });
    });
    return out;
  }, [words, effectiveSelections]);

  // First/last word index covered by each effective selection. Drives
  // where the start/end handles get inserted in the ribbon.
  const selectionBounds = useMemo(() => {
    return effectiveSelections.map((sel) => {
      let first = -1;
      let last = -1;
      for (let i = 0; i < words.length; i++) {
        if (wordOverlapsRange(words[i], sel)) {
          if (first === -1) first = i;
          last = i;
        }
      }
      return first === -1 ? null : { first, last };
    });
  }, [words, effectiveSelections]);

  const dragRange = useMemo(() => {
    if (!drag || drag.kind !== "create") return null;
    const lo = Math.min(drag.anchorWord, drag.cursorWord);
    const hi = Math.max(drag.anchorWord, drag.cursorWord);
    return { lo, hi };
  }, [drag]);

  const focusedSet = useMemo(
    () => new Set(focusedSelectionIndices),
    [focusedSelectionIndices],
  );
  const hasFocus = focusedSet.size > 0;

  // Commit the drag on global mouseup so the gesture survives the
  // cursor leaving the ribbon. Create-drags push (or replace if a
  // handle drag is mistakenly stuck in create); resize-drags rewrite
  // the corresponding selection.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      if (drag.kind === "create") {
        const lo = Math.min(drag.anchorWord, drag.cursorWord);
        const hi = Math.max(drag.anchorWord, drag.cursorWord);
        const first = words[lo];
        const last = words[hi];
        if (first && last) {
          onSelectionsChange([
            ...selections,
            { start: first.start, end: last.end },
          ]);
        }
      } else {
        const w = words[drag.cursorWord];
        if (w) {
          const next = selections.map((sel, i) => {
            if (i !== drag.selIdx) return sel;
            if (drag.side === "start") {
              return { start: Math.min(w.start, sel.end), end: sel.end };
            }
            return { start: sel.start, end: Math.max(w.end, sel.start) };
          });
          onSelectionsChange(next);
        }
      }
      setDrag(null);
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [drag, words, selections, onSelectionsChange]);

  const handleWordMouseDown = (i: WordIndex, e: React.MouseEvent) => {
    e.preventDefault();
    setDrag({ kind: "create", anchorWord: i, cursorWord: i });
  };

  const handleWordMouseEnter = (i: WordIndex) => {
    if (!drag) return;
    setDrag({ ...drag, cursorWord: i });
  };

  const handleStartResize = (
    selIdx: number,
    side: "start" | "end",
    initialWord: WordIndex,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag({ kind: "resize", selIdx, side, cursorWord: initialWord });
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
            const baseColor =
              CC_COLORS[w.transcriptionIndex % CC_COLORS.length];
            const covering = selectionsForWord[i];
            const inAnySelection = covering.length > 0;
            const inFocused = !hasFocus || covering.some((s) => focusedSet.has(s));
            const inDrag =
              dragRange != null && i >= dragRange.lo && i <= dragRange.hi;
            const highlight = inDrag || (inAnySelection && inFocused);
            const dim = !inDrag && inAnySelection && hasFocus && !inFocused;

            const startsHere: number[] = [];
            const endsHere: number[] = [];
            selectionBounds.forEach((b, selIdx) => {
              if (!b) return;
              if (b.first === i) startsHere.push(selIdx);
              if (b.last === i) endsHere.push(selIdx);
            });

            return (
              <React.Fragment key={i}>
                {startsHere.map((selIdx) => (
                  <SelectionHandle
                    key={`s${selIdx}`}
                    side="start"
                    selectionWord={selectionBounds[selIdx]!.first}
                    transcriptionIndex={w.transcriptionIndex}
                    focused={!hasFocus || focusedSet.has(selIdx)}
                    onMouseDown={(e) =>
                      handleStartResize(selIdx, "start", i, e)
                    }
                  />
                ))}
                <span
                  data-word-index={i}
                  onMouseDown={(e) => handleWordMouseDown(i, e)}
                  onMouseEnter={() => handleWordMouseEnter(i)}
                  style={wordStyle(baseColor, highlight, dim)}
                  title={`${formatTime(w.start)} → ${formatTime(w.end)}`}
                >
                  {w.text}
                </span>
                {endsHere.map((selIdx) => (
                  <SelectionHandle
                    key={`e${selIdx}`}
                    side="end"
                    selectionWord={selectionBounds[selIdx]!.last}
                    transcriptionIndex={w.transcriptionIndex}
                    focused={!hasFocus || focusedSet.has(selIdx)}
                    onMouseDown={(e) =>
                      handleStartResize(selIdx, "end", i, e)
                    }
                  />
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SelectionHandle({
  side,
  transcriptionIndex,
  focused,
  onMouseDown,
}: {
  side: "start" | "end";
  /** Word index this handle is currently anchored to — only used as a
   *  React debug-key hint; not part of the drag math. */
  selectionWord: WordIndex;
  transcriptionIndex: number;
  focused: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const color = CC_COLORS[transcriptionIndex % CC_COLORS.length];
  return (
    <span
      onMouseDown={onMouseDown}
      role="slider"
      aria-label={side === "start" ? "Resize selection start" : "Resize selection end"}
      style={{
        display: "inline-block",
        width: 8,
        height: 22,
        verticalAlign: "middle",
        background: focused ? color : `${color}55`,
        border: `1px solid ${focused ? "#fff" : color}aa`,
        borderRadius: 2,
        cursor: "ew-resize",
        margin: side === "start" ? "0 -2px 0 2px" : "0 2px 0 -2px",
        opacity: focused ? 1 : 0.7,
        boxShadow: focused
          ? "0 0 0 2px rgba(255, 255, 255, 0.18)"
          : "none",
      }}
    />
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
  dim: boolean,
): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "3px 7px",
    margin: "2px",
    background: highlighted
      ? color
      : dim
        ? "#1c1c1c"
        : `${color}22`,
    color: highlighted ? "#fff" : dim ? "#555" : "#ddd",
    borderRadius: 4,
    fontSize: 13,
    cursor: "text",
    userSelect: "none",
    border: `1px solid ${highlighted ? color : dim ? "#2a2a2a" : `${color}55`}`,
    opacity: dim ? 0.45 : 1,
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
