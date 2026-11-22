// `@seam/extension-text/editor` — what Text adds to the editor: the part of
// the Properties panel its structured fields need. (The plain style fields —
// font, size, colour, … — get their rows generated from the node type's
// field declarations; the "New" tile and the timeline label are declared on
// the node type itself.)
//
// This entry alone depends on React.

import React, { useEffect, useState } from "react";
import type { Child, EditorExtension, EditorPropertyProps } from "@seam/core";
import type { TextNode } from "./index.js";

type Box = number | [number, number] | [number, number, number, number];

/** `"12"`, `"12, 24"` or four values ⇄ the padding shorthand. `undefined` =
 *  unset, `null` = not a valid entry. */
export function parsePadding(text: string): Box | undefined | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return [nums[0], nums[1]];
  if (nums.length === 4) return [nums[0], nums[1], nums[2], nums[3]];
  return null;
}

const formatPadding = (value: unknown): string =>
  value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);

/** A value every node agrees on, or `MIXED`. */
const MIXED = Symbol("mixed");
function shared<T>(nodes: readonly Child[], read: (node: TextNode) => T): T | typeof MIXED {
  const first = JSON.stringify(read(nodes[0] as TextNode));
  return nodes.every((n) => JSON.stringify(read(n as TextNode)) === first) ? read(nodes[0] as TextNode) : MIXED;
}

/** The "Text" section: what the text says, and the padding of its layout box. */
function TextContentEditor({ nodes, update }: EditorPropertyProps) {
  const content = shared(nodes, (n) => n.text);
  const padding = shared(nodes, (n) => n.padding);
  const set = (key: "text" | "padding", value: unknown) =>
    update((node) => {
      const { [key]: _old, ...rest } = node as unknown as Record<string, unknown>;
      return (value === undefined ? rest : { ...rest, [key]: value }) as unknown as Child;
    });

  return (
    <div style={{ fontSize: 12 }}>
      {content !== MIXED && typeof content !== "string" ? (
        <div style={{ color: "#777", fontSize: 11, marginBottom: 4 }}>Inline styled runs — edit in the JSON panel.</div>
      ) : (
        <Commit
          multiline
          value={content === MIXED ? "" : content}
          placeholder={content === MIXED ? "—" : ""}
          // A text node always has text: an empty box leaves it as it was.
          onCommit={(s) => s !== "" && set("text", s)}
        />
      )}
      <label style={ROW} title="Inset of the layout box: one number, 'vertical, horizontal', or 'top, right, bottom, left'.">
        <span style={{ width: 84, flexShrink: 0, color: "#aaa" }}>Padding</span>
        <Commit
          value={padding === MIXED ? "" : formatPadding(padding)}
          placeholder={padding === MIXED ? "—" : "0"}
          onCommit={(s) => {
            const box = parsePadding(s);
            if (box !== null) set("padding", box);
          }}
        />
      </label>
    </div>
  );
}

/** A box that commits on blur (and Enter, for a single line) and reverts on
 *  Escape. An entry the caller rejects snaps back to the authored value. */
function Commit({
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = multiline ? draft : draft.trim();
    if (next !== value) onCommit(next);
    setDraft(value);
  };
  const common = {
    value: draft,
    placeholder,
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = e.target as HTMLElement;
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) el.blur();
      if (e.key === "Escape") {
        setDraft(value);
        requestAnimationFrame(() => el.blur());
      }
    },
  };
  return multiline ? (
    <textarea {...common} rows={3} style={{ ...INPUT, width: "100%", boxSizing: "border-box", resize: "vertical", marginBottom: 4 }} />
  ) : (
    <input {...common} style={{ ...INPUT, flex: 1, minWidth: 0 }} />
  );
}

const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 };
const INPUT: React.CSSProperties = {
  background: "#111",
  color: "#ddd",
  border: "1px solid #333",
  borderRadius: 3,
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "inherit",
};

/** The Text extension's editor side. */
export const textEditor: EditorExtension = {
  name: "text",
  properties: [{ field: "text", label: "Text content", component: TextContentEditor }],
};

export default textEditor;
