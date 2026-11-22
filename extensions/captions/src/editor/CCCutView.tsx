// The CC cut view: cut a composition by what is said in it.
//
// Opened on a selected composition. Every word that bubbles up inside it is
// laid out as a ribbon; dragging across words marks a range to KEEP. The
// editor previews the result live (the composition replaced, in place, by one
// windowed piece per range — `tools.keepRanges`, i.e. split + delete at
// scale), and Apply commits exactly that preview as one undo step.
//
// An extension view (`EditorExtension.views`): it sees the editor only
// through its props.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Composition, EditorViewProps, SeamFile } from "@seam/core";
import { cutWords, innerToGlobal, type CutWord } from "../cut.js";

interface Range {
  /** Composition inner time. */
  start: number;
  end: number;
}

type Drag =
  | { kind: "create"; anchor: number; cursor: number }
  | { kind: "resize"; range: number; side: "start" | "end"; cursor: number };

/** Phrase colours, cycled per caption so phrase boundaries read at a glance. */
const COLORS = ["#4a9eff", "#ff6b6b", "#51cf66", "#ffd43b", "#cc5de8", "#22b8cf", "#fd7e14", "#94d82d"];

const overlaps = (w: { start: number; end: number }, r: Range) => w.start < r.end && w.end > r.start;

/** The node at a `children.N…` path key of `doc` (bin-rooted keys: null). */
function nodeAt(doc: SeamFile, key: string): Composition | null {
  const parts = key.split(".");
  let node: unknown = doc;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "children") return null;
    node = (node as { children?: unknown[] } | null)?.children?.[Number(parts[i + 1])];
    if (node == null) return null;
  }
  return node as Composition;
}

export default function CCCutView({ context, target, preview, close, player }: EditorViewProps) {
  const { document, tools } = context;
  const [ranges, setRanges] = useState<Range[]>([]);
  const [drag, setDragState] = useState<Drag | null>(null);
  // Mirrored in a ref: a quick release can land before the render that
  // follows the last mouse-enter, and the mouseup must see that last word.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };

  // The words, once per document: the composition resolved on its own.
  const composition = context.node(target) as (Composition & { in?: number }) | null;
  const inTime = composition?.in ?? 0;
  const resolved = useMemo(() => context.resolve(target), [document, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = useMemo(() => cutWords(resolved, inTime), [resolved, inTime]);

  // What applying would produce — also what the editor previews.
  const result = useMemo(
    () => (ranges.length > 0 ? tools.keepRanges(document, target, ranges) : null),
    [tools, document, target, ranges],
  );
  useEffect(() => {
    preview(result?.ok ? result.doc : null);
  }, [result, preview]);

  // The drag applied to a copy, so the ribbon shows the would-be shape.
  const resized = (d: Drag | null): Range[] => {
    if (!d || d.kind !== "resize") return ranges;
    const w = words[d.cursor];
    if (!w) return ranges;
    return ranges.map((r, i) =>
      i !== d.range
        ? r
        : d.side === "start"
          ? { start: Math.min(w.start, r.end), end: r.end }
          : { start: r.start, end: Math.max(w.end, r.start) },
    );
  };
  const shown = useMemo<Range[]>(() => resized(drag), [drag, words, ranges]); // eslint-disable-line react-hooks/exhaustive-deps

  /** First / last word index each range covers. */
  const bounds = useMemo(
    () =>
      shown.map((r) => {
        let first = -1;
        let last = -1;
        words.forEach((w, i) => {
          if (!overlaps(w, r)) return;
          if (first === -1) first = i;
          last = i;
        });
        return first === -1 ? null : { first, last };
      }),
    [shown, words],
  );

  const creating =
    drag?.kind === "create"
      ? { lo: Math.min(drag.anchor, drag.cursor), hi: Math.max(drag.anchor, drag.cursor) }
      : null;

  // Commit on a global mouseup so the gesture survives leaving the ribbon.
  // The listener is attached in the mousedown itself (not an effect) and
  // reads the latest state through refs, so a quick press-drag-release is
  // never lost between renders.
  const finish = () => {
    const d = dragRef.current;
    if (d?.kind === "create") {
      const first = words[Math.min(d.anchor, d.cursor)];
      const last = words[Math.max(d.anchor, d.cursor)];
      if (first && last) setRanges((rs) => [...rs, { start: first.start, end: last.end }]);
    } else if (d) {
      setRanges(resized(d));
    }
    setDrag(null);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const begin = (d: Drag) => {
    setDrag(d);
    window.addEventListener("mouseup", () => finishRef.current(), { once: true });
  };

  /** Move the playhead to where `word` plays in what the editor shows. */
  const seekTo = (word: CutWord) => {
    if (result?.ok) {
      // In the preview: find the piece whose window holds the word.
      for (const key of result.pieces) {
        const piece = nodeAt(result.doc, key);
        const span = player.spanOf(key);
        if (!piece || !span || piece.in == null || piece.out == null) continue;
        if (word.start >= piece.in - 1e-6 && word.start < piece.out) {
          player.seek(innerToGlobal(word.start, { in: piece.in, out: piece.out }, span));
          return;
        }
      }
      return; // the word is cut out — nowhere to go
    }
    const span = player.spanOf(target);
    if (!span || !resolved || resolved.type !== "composition") return;
    const length = resolved.duration * (resolved.speed || 1);
    player.seek(innerToGlobal(word.start, { in: inTime, out: inTime + length }, span));
  };

  const apply = () => {
    if (!result?.ok) return;
    context.edit(result.doc, { select: result.pieces });
    close();
  };

  const kept = shown.reduce((sum, r) => sum + (r.end - r.start), 0);

  return (
    <div style={ROOT}>
      <div style={HEADER}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>CC cut</div>
        <div style={{ flex: 1, fontSize: 11, color: "#999" }}>
          {words.length === 0
            ? ""
            : ranges.length === 0
              ? "Drag across words to mark what to keep. Alt-click a word to jump to it."
              : `${ranges.length} range${ranges.length === 1 ? "" : "s"} · ${kept.toFixed(1)} s kept`}
        </div>
        {ranges.length > 0 && (
          <button style={BTN} onClick={() => setRanges([])} title="Remove every range">
            Clear
          </button>
        )}
        <button style={BTN} onClick={close} title="Leave without cutting">
          Cancel
        </button>
        <button
          style={result?.ok ? BTN_PRIMARY : { ...BTN_PRIMARY, opacity: 0.35, cursor: "default" }}
          disabled={!result?.ok}
          onClick={apply}
          title="Replace the composition with the kept ranges"
        >
          Apply
        </button>
      </div>
      {result && !result.ok && <div style={ERROR}>{result.error}</div>}
      {composition?.type !== "composition" ? (
        <div style={EMPTY}>CC cut works on a composition.</div>
      ) : words.length === 0 ? (
        <div style={EMPTY}>
          There are no captions inside this composition. Generate them first (the CC button), then cut by
          what was said.
        </div>
      ) : (
        <div style={RIBBON_WRAP}>
          <div style={RIBBON}>
            {words.map((w, i) => {
              const color = COLORS[w.cue % COLORS.length];
              const on = (creating != null && i >= creating.lo && i <= creating.hi) || shown.some((r) => overlaps(w, r));
              const starts: number[] = [];
              const ends: number[] = [];
              bounds.forEach((b, r) => {
                if (b?.first === i) starts.push(r);
                if (b?.last === i) ends.push(r);
              });
              return (
                <React.Fragment key={i}>
                  {starts.map((r) => (
                    <span
                      key={`s${r}`}
                      style={handleStyle(color, "start")}
                      title="Drag to move the start of this range"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        begin({ kind: "resize", range: r, side: "start", cursor: i });
                      }}
                    />
                  ))}
                  <span
                    style={wordStyle(color, on)}
                    title={`${stamp(w.start)} → ${stamp(w.end)}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (e.altKey) seekTo(w);
                      else begin({ kind: "create", anchor: i, cursor: i });
                    }}
                    onMouseEnter={() => {
                      const d = dragRef.current;
                      if (d && d.cursor !== i) setDrag({ ...d, cursor: i });
                    }}
                  >
                    {w.text}
                  </span>
                  {ends.map((r) => (
                    <React.Fragment key={`e${r}`}>
                      <span
                        style={handleStyle(color, "end")}
                        title="Drag to move the end of this range"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          begin({ kind: "resize", range: r, side: "end", cursor: i });
                        }}
                      />
                      <span
                        style={REMOVE}
                        title="Remove this range"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setRanges((rs) => rs.filter((_, k) => k !== r));
                        }}
                      >
                        ×
                      </span>
                    </React.Fragment>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function stamp(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}

function wordStyle(color: string, on: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "3px 7px",
    margin: 2,
    background: on ? color : `${color}22`,
    color: on ? "#fff" : "#ddd",
    border: `1px solid ${on ? color : `${color}55`}`,
    borderRadius: 4,
    fontSize: 13,
    cursor: "text",
    userSelect: "none",
  };
}

function handleStyle(color: string, side: "start" | "end"): React.CSSProperties {
  return {
    display: "inline-block",
    width: 8,
    height: 22,
    verticalAlign: "middle",
    background: color,
    border: "1px solid #ffffffaa",
    borderRadius: 2,
    cursor: "ew-resize",
    margin: side === "start" ? "0 -2px 0 2px" : "0 2px 0 -2px",
  };
}

const ROOT: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  background: "#1a1a1a",
  color: "#fff",
};
const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderBottom: "1px solid #333",
};
const BTN: React.CSSProperties = {
  background: "#2a2a2a",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const BTN_PRIMARY: React.CSSProperties = { ...BTN, background: "#2f6fed", borderColor: "#2f6fed", color: "#fff" };
const ERROR: React.CSSProperties = { padding: "6px 12px", fontSize: 12, color: "#ff8a8a", borderBottom: "1px solid #333" };
const EMPTY: React.CSSProperties = { padding: 24, color: "#888", fontSize: 13, lineHeight: 1.5 };
const RIBBON_WRAP: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", padding: 12 };
const RIBBON: React.CSSProperties = { fontFamily: "ui-monospace, monospace", lineHeight: 1.6 };
const REMOVE: React.CSSProperties = {
  display: "inline-block",
  width: 14,
  textAlign: "center",
  verticalAlign: "middle",
  color: "#aaa",
  fontSize: 13,
  cursor: "pointer",
  userSelect: "none",
};
